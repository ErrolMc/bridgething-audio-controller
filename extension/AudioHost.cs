// AudioHost.cs is the part of audio-controller that talks to Windows. It wraps the Windows
// Core Audio API, the same API the Volume mixer in Windows settings uses.
//
// What it does:
//   - lists the apps that have an audio session on a playback device, with each app's
//     volume, mute state and current peak level
//   - sets an app's volume, or mutes and unmutes it
//   - reads each app's name and icon from its .exe
//
// What it doesn't do: it opens no network connections, writes no files, changes nothing in
// the registry and starts no processes. It never reads or writes another process's memory.
// The only access it asks for on another process is PROCESS_QUERY_LIMITED_INFORMATION, which
// can read the path of the process's .exe. It leaves nothing behind, and exits when the
// extension closes its stdin.
//
// How it runs: extension/audio.ts starts one long-lived
//   powershell.exe -NoProfile -NonInteractive -Command "...; Add-Type -Path '<this file>' -ReferencedAssemblies System.Drawing; [AudioController.Host]::Run()"
// Add-Type compiles this file with the .NET Framework that ships with Windows (the compiler
// keeps its scratch files in %TEMP% while it runs). Run() then answers commands on stdin,
// one line each way:
//   in:  "<id> list" | "<id> volume <key> <0..1>" | "<id> mute <key> <0|1>" | "<id> icon <key>"
//   out: {"id":<id>,"type":"sessions"|"ok"|"icon"|"error",...}
// It prints {"id":0,"type":"ready"} once it's compiled.
//
// Add-Type in Windows PowerShell 5.1 compiles C# 5, so no string interpolation, ?. or out var.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace AudioController
{
    // The Core Audio interfaces, as declared in mmdeviceapi.h and audiopolicy.h in the Windows
    // SDK. COM finds a method by its position, not its name, so each interface lists its methods
    // in the SDK's order, up to the last one this file calls.

    // the system's audio device list (CLSID_MMDeviceEnumerator)
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    // lists audio devices
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    }

    // the devices EnumAudioEndpoints found
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    // one output device, such as speakers or headphones
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object result);
    }

    // the audio sessions on one device. Only GetSessionEnumerator is called; the two before it
    // are declared to keep it in the third slot.
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    // the sessions GetSessionEnumerator found
    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
    }

    // one app's session on one device. This file calls GetState, GetDisplayName, GetProcessId
    // and IsSystemSoundsSession. The Set, Register and other Get methods are never called;
    // they're declared so the four that are called sit in the right slots.
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out int pid);
        [PreserveSig] int IsSystemSoundsSession();
    }

    // a session's volume and mute: the slider for that app in the Volume mixer
    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // a session's current peak level, which drives the moving bars on its tile (endpointvolume.h)
    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
    }

    // the bitmaps behind an icon, filled in by GetIconInfo (winuser.h)
    [StructLayout(LayoutKind.Sequential)]
    struct ICONINFO
    {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    // what the grid shows for one .exe
    class ProcessInfo
    {
        public string Key;
        public string Name;
        public string Path;
    }

    // every session of one .exe, across every output device, is one app
    class App
    {
        public ProcessInfo Info;
        public float Volume;
        public bool Muted = true;
        public bool Active;
        public float Peak;
        public List<ISimpleAudioVolume> Volumes = new List<ISimpleAudioVolume>();
    }

    public static class Host
    {
        // eRender (mmdeviceapi.h): playback devices only, never microphones
        const int ERender = 0;
        // DEVICE_STATE_ACTIVE: devices that are plugged in and enabled
        const int DeviceStateActive = 1;
        // CLSCTX_INPROC_SERVER (wtypesbase.h): the session manager runs inside this process
        const int ClsCtxInprocServer = 1;
        // AudioSessionState values (audiosessiontypes.h)
        const int SessionActive = 1;
        const int SessionExpired = 2;
        // PROCESS_QUERY_LIMITED_INFORMATION (winnt.h). It can read a process's .exe path and
        // exit code. It can't read or write the process's memory, and can't control or end it.
        const int ProcessQueryLimitedInformation = 0x1000;
        // QueryFullProcessImageName returns a C:\ style path with this flag
        const int Win32PathFormat = 0;
        // icon sizes in pixels
        const int IconSize = 128;
        const int SmallIconSize = 16;

        static readonly Dictionary<int, ProcessInfo> processes = new Dictionary<int, ProcessInfo>();
        static readonly Dictionary<string, string> iconPaths = new Dictionary<string, string>();
        static readonly List<object> comObjects = new List<object>();
        static Guid eventContext = Guid.Empty;
        static ProcessInfo systemSounds;

        // opens a handle to a process; only ever called with ProcessQueryLimitedInformation
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
        // the full path of a process's .exe
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
        // closes the handle OpenProcess returned
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        // an .exe's own icon at a given size
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHDefExtractIcon(string iconFile, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
        // frees an icon SHDefExtractIcon returned
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
        // the colour and mask bitmaps behind an icon
        [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
        // frees a bitmap GetIconInfo returned
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);

        // the entry point audio.ts calls: answers commands on stdin until stdin closes
        public static void Run()
        {
            // the Volume mixer's own .exe, used only for the System sounds icon
            string sndVol = Environment.ExpandEnvironmentVariables(@"%SystemRoot%\System32\SndVol.exe");
            systemSounds = new ProcessInfo();
            // Executable and fallback process keys use separate prefixes.
            systemSounds.Key = "system:sounds";
            systemSounds.Name = "System sounds";
            systemSounds.Path = File.Exists(sndVol) ? sndVol : null;

            var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.WriteLine("{\"id\":0,\"type\":\"ready\"}");
            output.Flush();

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string[] parts = line.Trim().Split(' ');
                int id;
                if (parts.Length < 2 || !int.TryParse(parts[0], out id)) continue;
                string body;
                try { body = Handle(parts); }
                catch (Exception e) { body = "\"type\":\"error\",\"message\":" + Json(e.Message); }
                finally { Release(); }
                output.WriteLine("{\"id\":" + id + "," + body + "}");
                output.Flush();
            }
        }

        // one command: list, icon, volume or mute
        static string Handle(string[] parts)
        {
            string command = parts[1];
            if (command == "list") return List(Enumerate());
            if (parts.Length < 3) throw new ArgumentException(command + " needs a key");
            string key = parts[2];
            if (command == "icon")
                return "\"type\":\"icon\",\"key\":" + Json(key) + ",\"png\":" + Json(IconPng(key));
            if (parts.Length < 4) throw new ArgumentException(command + " needs a value");

            App app;
            if (!Enumerate().TryGetValue(key, out app)) throw new ArgumentException("no audio session for " + key);
            if (command == "volume")
            {
                float level = Math.Max(0f, Math.Min(1f, float.Parse(parts[3], CultureInfo.InvariantCulture)));
                SetVolume(app, level);
                return "\"type\":\"ok\"";
            }
            if (command == "mute")
            {
                bool mute = parts[3] == "1";
                SetMute(app, mute);
                return "\"type\":\"ok\"";
            }
            throw new ArgumentException("unknown command " + command);
        }

        static void SetVolume(App app, float level)
        {
            SetAll(app, volume => volume.SetMasterVolume(level, ref eventContext));
        }

        static void SetMute(App app, bool mute)
        {
            SetAll(app, volume => volume.SetMute(mute, ref eventContext));
        }

        // every session gets the change even when one fails, then the first failure is reported
        static void SetAll(App app, Func<ISimpleAudioVolume, int> set)
        {
            int first = 0;
            foreach (var volume in app.Volumes)
            {
                int hr = set(volume);
                if (first >= 0) first = hr;
            }
            Check(first);
        }

        // every app with a live session on any playback device, keyed by its .exe
        static Dictionary<string, App> Enumerate()
        {
            var apps = new Dictionary<string, App>();
            var seen = new HashSet<int>();
            var enumerator = (IMMDeviceEnumerator)Track(new MMDeviceEnumerator());
            IMMDeviceCollection devices;
            Check(enumerator.EnumAudioEndpoints(ERender, DeviceStateActive, out devices));
            Track(devices);
            int deviceCount;
            Check(devices.GetCount(out deviceCount));
            Guid managerId = typeof(IAudioSessionManager2).GUID;

            for (int d = 0; d < deviceCount; d++)
            {
                IMMDevice device;
                if (devices.Item(d, out device) != 0) continue;
                Track(device);
                object managerObject;
                if (device.Activate(ref managerId, ClsCtxInprocServer, IntPtr.Zero, out managerObject) != 0) continue;
                var manager = (IAudioSessionManager2)Track(managerObject);
                IAudioSessionEnumerator sessions;
                if (manager.GetSessionEnumerator(out sessions) != 0) continue;
                Track(sessions);
                int count;
                if (sessions.GetCount(out count) != 0) continue;

                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl2 control;
                    if (sessions.GetSession(i, out control) != 0) continue;
                    Track(control);
                    int state;
                    if (control.GetState(out state) != 0 || state == SessionExpired) continue;
                    int pid;
                    ProcessInfo info = Describe(control, out pid);
                    if (info == null) continue;
                    seen.Add(pid);

                    // the same session object also answers as ISimpleAudioVolume and
                    // IAudioMeterInformation; these casts are COM's QueryInterface
                    var volume = (ISimpleAudioVolume)control;
                    float level;
                    bool muted;
                    if (volume.GetMasterVolume(out level) != 0 || volume.GetMute(out muted) != 0) continue;
                    float peak = 0;
                    var meter = control as IAudioMeterInformation;
                    if (meter == null || meter.GetPeakValue(out peak) != 0) peak = 0;

                    App app;
                    if (!apps.TryGetValue(info.Key, out app))
                    {
                        app = new App();
                        app.Info = info;
                        apps[info.Key] = app;
                    }
                    app.Volume = Math.Max(app.Volume, level);
                    app.Muted = app.Muted && muted;
                    app.Active = app.Active || state == SessionActive;
                    app.Peak = Math.Max(app.Peak, peak);
                    app.Volumes.Add(volume);
                }
            }

            // forget processes that have gone, so a reused pid is described afresh
            var gone = new List<int>();
            foreach (int known in processes.Keys) if (!seen.Contains(known)) gone.Add(known);
            foreach (int old in gone) processes.Remove(old);
            return apps;
        }

        // who a session belongs to: its key, name and .exe path, cached by pid
        static ProcessInfo Describe(IAudioSessionControl2 control, out int pid)
        {
            pid = 0;
            if (control.IsSystemSoundsSession() == 0) return systemSounds;
            // a session shared by several processes still reports its first pid
            control.GetProcessId(out pid);
            if (pid == 0) return null;
            ProcessInfo info;
            if (processes.TryGetValue(pid, out info)) return info;

            string path = ImagePath(pid);
            string exe = path != null ? Path.GetFileNameWithoutExtension(path) : null;
            if (exe == null)
            {
                try { exe = Process.GetProcessById(pid).ProcessName; }
                catch { return null; }
            }
            // the name Task Manager shows comes from the .exe's version info
            string name = null;
            if (path != null)
            {
                try
                {
                    var version = FileVersionInfo.GetVersionInfo(path);
                    name = Clean(version.FileDescription) ?? Clean(version.ProductName);
                }
                catch { }
            }
            if (name == null)
            {
                string display;
                if (control.GetDisplayName(out display) == 0) name = Clean(display);
            }

            info = new ProcessInfo();
            info.Key = AppKey(path, pid);
            info.Name = name ?? exe;
            info.Path = path;
            processes[pid] = info;
            return info;
        }

        // Group the same executable across processes, without merging unrelated files that
        // share a name. Hash the normalized path so the device doesn't receive local paths.
        // If Windows hides the path, keep that process separate instead of guessing by name.
        static string AppKey(string path, int pid)
        {
            if (path == null) return "pid:" + pid.ToString(CultureInfo.InvariantCulture);
            // QueryFullProcessImageName already gives a full path. Path.GetFullPath would throw on
            // one past 260 characters in Windows PowerShell 5.1, and fail the whole list.
            string normalized = path.ToUpperInvariant();
            using (var hash = SHA256.Create())
                return "exe:" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(normalized))).Replace("-", "").ToLowerInvariant();
        }

        // display names starting with @ are unresolved resource references
        static string Clean(string value)
        {
            if (value == null) return null;
            value = value.Trim();
            return value.Length == 0 || value.StartsWith("@") ? null : value;
        }

        // the path of a process's .exe, or null when Windows refuses, as it does for some system processes
        static string ImagePath(int pid)
        {
            IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
            if (handle == IntPtr.Zero) return null;
            try
            {
                var buffer = new StringBuilder(1024);
                int size = buffer.Capacity;
                return QueryFullProcessImageName(handle, Win32PathFormat, buffer, ref size) ? buffer.ToString(0, size) : null;
            }
            finally { CloseHandle(handle); }
        }

        // the reply to list, which also remembers each app's .exe for a later icon command
        static string List(Dictionary<string, App> apps)
        {
            var json = new StringBuilder("\"type\":\"sessions\",\"apps\":[");
            bool first = true;
            foreach (var app in apps.Values)
            {
                iconPaths[app.Info.Key] = app.Info.Path;
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"key\":").Append(Json(app.Info.Key))
                    .Append(",\"name\":").Append(Json(app.Info.Name))
                    .Append(",\"volume\":").Append(Number(app.Volume))
                    .Append(",\"muted\":").Append(app.Muted ? "true" : "false")
                    .Append(",\"active\":").Append(app.Active ? "true" : "false")
                    .Append(",\"peak\":").Append(Number(app.Peak))
                    .Append('}');
            }
            return json.Append(']').ToString();
        }

        // an app's icon as a base64 png, or null
        static string IconPng(string key)
        {
            string path;
            if (!iconPaths.TryGetValue(key, out path) || path == null) return null;
            IntPtr large, small;
            // SHDefExtractIcon takes both sizes in one argument: large in the low word, small in the high
            uint sizes = (uint)(IconSize | (SmallIconSize << 16));
            if (SHDefExtractIcon(path, 0, 0, out large, out small, sizes) != 0 || large == IntPtr.Zero)
            {
                // when that fails, take the 32 px icon Windows shows for the file
                try
                {
                    using (var icon = Icon.ExtractAssociatedIcon(path))
                    using (var bitmap = icon.ToBitmap())
                        return Png(bitmap);
                }
                catch { return null; }
            }
            try
            {
                using (var bitmap = IconBitmap(large)) return Png(bitmap);
            }
            finally
            {
                DestroyIcon(large);
                if (small != IntPtr.Zero) DestroyIcon(small);
            }
        }

        // Icon.ToBitmap flattens alpha for icons made from a handle, so read the colour
        // bitmap's bytes directly and fall back to ToBitmap when it has no alpha channel
        static Bitmap IconBitmap(IntPtr icon)
        {
            ICONINFO info;
            if (GetIconInfo(icon, out info))
            {
                try
                {
                    if (info.hbmColor != IntPtr.Zero)
                    {
                        using (var color = Image.FromHbitmap(info.hbmColor))
                        {
                            Bitmap withAlpha = CopyWithAlpha(color);
                            if (withAlpha != null) return withAlpha;
                        }
                    }
                }
                finally
                {
                    if (info.hbmColor != IntPtr.Zero) DeleteObject(info.hbmColor);
                    if (info.hbmMask != IntPtr.Zero) DeleteObject(info.hbmMask);
                }
            }
            using (var fallback = Icon.FromHandle(icon)) return fallback.ToBitmap();
        }

        // Copies a 32-bit bitmap's pixels into a new bitmap marked as having alpha, so the icon's
        // transparency survives. Returns null when every alpha byte is 0, because then the icon
        // has no alpha channel and its mask does the job instead.
        static Bitmap CopyWithAlpha(Bitmap source)
        {
            if (Image.GetPixelFormatSize(source.PixelFormat) != 32) return null;
            var rect = new Rectangle(0, 0, source.Width, source.Height);
            int rowBytes = source.Width * 4;
            var pixels = new byte[rowBytes * source.Height];
            // LockBits exposes the bitmap's own pixel buffer. Stride is a row's length there,
            // which can include padding, so the copy goes one row at a time.
            BitmapData data = source.LockBits(rect, ImageLockMode.ReadOnly, source.PixelFormat);
            try
            {
                for (int y = 0; y < source.Height; y++)
                    Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), pixels, y * rowBytes, rowBytes);
            }
            finally { source.UnlockBits(data); }

            // each pixel is 4 bytes, blue, green, red, alpha
            bool hasAlpha = false;
            for (int i = 3; i < pixels.Length; i += 4) if (pixels[i] != 0) { hasAlpha = true; break; }
            if (!hasAlpha) return null;

            var result = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
            BitmapData target = result.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                for (int y = 0; y < source.Height; y++)
                    Marshal.Copy(pixels, y * rowBytes, new IntPtr(target.Scan0.ToInt64() + (long)y * target.Stride), rowBytes);
            }
            finally { result.UnlockBits(target); }
            return result;
        }

        // encodes in memory; nothing touches the disk
        static string Png(Bitmap bitmap)
        {
            using (var stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                return Convert.ToBase64String(stream.ToArray());
            }
        }

        // the COM objects one command opens. Release() frees them once it's answered, so
        // nothing holds a device or session open between commands.
        static object Track(object com)
        {
            if (com != null) comObjects.Add(com);
            return com;
        }

        static void Release()
        {
            foreach (var com in comObjects)
            {
                try { Marshal.ReleaseComObject(com); }
                catch { }
            }
            comObjects.Clear();
        }

        // turns a failed HRESULT into an exception
        static void Check(int hr)
        {
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        }

        // '.' as the decimal point, whatever the locale
        static string Number(float value)
        {
            return value.ToString("0.####", CultureInfo.InvariantCulture);
        }

        // escapes everything outside printable ascii, so the console encoding never matters
        static string Json(string value)
        {
            if (value == null) return "null";
            var json = new StringBuilder("\"");
            foreach (char c in value)
            {
                if (c == '"') json.Append("\\\"");
                else if (c == '\\') json.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) json.Append("\\u").Append(((int)c).ToString("x4"));
                else json.Append(c);
            }
            return json.Append('"').ToString();
        }
    }
}
