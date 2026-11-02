using System;
using System.Reflection;
using System.Runtime.InteropServices;

namespace AudioController
{
    // Compiled beside the real helper for tests only. Never touches Windows audio.
    class FakeVolume : ISimpleAudioVolume
    {
        public int Result;
        public int VolumeCalls;
        public int MuteCalls;
        public int SetMasterVolume(float level, ref Guid context) { VolumeCalls++; return Result; }
        public int GetMasterVolume(out float level) { level = 0; return 0; }
        public int SetMute(bool mute, ref Guid context) { MuteCalls++; return Result; }
        public int GetMute(out bool mute) { mute = false; return 0; }
    }

    public static class AudioHostTests
    {
        static object Call(string name, params object[] args)
        {
            return typeof(Host).GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, args);
        }

        static void Require(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }

        static void Fails(string method, App app, object value)
        {
            try { Call(method, app, value); }
            catch (TargetInvocationException e)
            {
                Require(e.InnerException is COMException, "Expected a COM failure from " + method);
                return;
            }
            throw new Exception(method + " incorrectly reported success");
        }

        public static void Run()
        {
            string first = (string)Call("AppKey", @"C:\One\player.exe", 1);
            string second = (string)Call("AppKey", @"C:\Two\player.exe", 2);
            Require(first != second, "Different executable paths were merged");
            Require(first == (string)Call("AppKey", @"c:\one\PLAYER.EXE", 2), "Paths differing only in case should group across PIDs");
            string deep = (string)Call("AppKey", @"C:\" + new string('a', 270) + ".exe", 3);
            Require(deep.StartsWith("exe:"), "A path past 260 characters should still get a key");
            Require(first.StartsWith("exe:") && first.Length == 68, "Key should contain a hash, not the local path");
            Require((string)Call("AppKey", null, 1) != (string)Call("AppKey", null, 2), "Unknown paths must stay separate by PID");
            var app = new App();
            var a = new FakeVolume();
            var b = new FakeVolume();
            app.Volumes.Add(a);
            app.Volumes.Add(b);
            Call("SetVolume", app, 0.5f);
            Call("SetMute", app, true);
            Require(a.VolumeCalls == 1 && b.VolumeCalls == 1 && a.MuteCalls == 1 && b.MuteCalls == 1, "Not all sessions were updated");
            a.Result = unchecked((int)0x88890004); // AUDCLNT_E_DEVICE_INVALIDATED
            Fails("SetVolume", app, 0.5f);
            Fails("SetMute", app, true);
            Require(b.VolumeCalls == 2 && b.MuteCalls == 2, "A failing session stopped the sessions after it");
            Console.WriteLine("Native identity and HRESULT regression checks passed");
        }
    }
}
