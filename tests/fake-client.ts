let available = true;
let onCaps = (_snapshot: unknown) => {};
let onMessage = (_message: unknown) => {};
export const sent: { type: string }[] = [];
const snapshot = () => ({ capabilities: { available: { forward: available } } });

export function link(value: boolean) {
  available = value;
  onCaps(snapshot());
}

export function message(value: unknown) { onMessage(value); }

export class BridgethingClient {
  capabilities = {
    get: async () => ({ ok: true, response: snapshot() }),
    subscribePartial: (callbacks: { update: typeof onCaps }) => {
      onCaps = callbacks.update;
      return () => { onCaps = () => {}; };
    },
  };
  forward = {
    json: async (value: { type: string }) => { sent.push(value); },
    onJson: (callback: typeof onMessage) => {
      onMessage = callback;
      return () => { onMessage = () => {}; };
    },
  };
  config = {
    get: async () => ({ ok: true, response: { value: '2' } }),
    onChanged: () => () => {},
  };
}
