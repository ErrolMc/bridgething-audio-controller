import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { link, message, sent } from './fake-client';

const sleep = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const require = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const slider = () => document.querySelector('[role="slider"]')!;
const mutedButton = () => [...document.querySelectorAll('button')].find(button => /^(Unmute|Mute)$/.test(button.textContent!))!;
const changes = () => sent.filter(command => command.type === 'setVolume' || command.type === 'setMute').length;
const wheel = () => window.dispatchEvent(new WheelEvent('wheel', { deltaX: 120, cancelable: true }));
const session = (volume: number) => message({ type: 'sessions', apps: [{ key: 'exe:test', name: 'Test Player', volume, muted: false, active: true, peak: 0.1 }] });

async function run() {
  createRoot(document.getElementById('root')!).render(<App />);
  await sleep(100);
  session(0.5);
  await sleep();
  [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Test Player'))!.click();
  await sleep();
  require(!mutedButton().disabled, 'Connected controls should work');

  wheel();
  wheel(); // Queue a throttled volume update, then disconnect before it can be sent.
  require(changes() === 1, 'Expected the first volume change to be sent');
  link(false);
  await sleep(100);
  require(changes() === 1, 'Queued volume escaped after disconnect');
  require(mutedButton().disabled, 'Mute should be disabled offline');
  require(slider().getAttribute('aria-disabled') === 'true', 'Slider should be disabled offline');
  require(slider().getAttribute('aria-valuenow') === '50', 'Offline volume should revert to the last PC value');
  require(document.body.textContent?.includes('PC not connected'), 'Missing disconnect notice');
  wheel();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  slider().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 400, pointerId: 1 }));
  mutedButton().click();
  await sleep(100);
  require(changes() === 1, 'Offline controls sent commands');
  require(slider().getAttribute('aria-valuenow') === '50', 'Offline controls changed displayed volume');

  link(true);
  await sleep();
  require(mutedButton().disabled, 'Reconnect must wait for a fresh session list');
  session(0.25);
  await sleep();
  require(!mutedButton().disabled && slider().getAttribute('aria-valuenow') === '25', 'Fresh PC state should enable controls');
  wheel();
  await sleep();
  require(changes() === 2, 'Recovered controls should send commands');

  message({ type: 'error', message: 'Audio device unavailable' });
  await sleep();
  require(mutedButton().disabled, 'Helper errors must disable controls');
  require(document.body.textContent?.includes('Audio device unavailable'), 'Missing helper error notice');
  require(slider().getAttribute('aria-valuenow') === '25', 'Failed changes should clear optimistic volume');
  session(0.3);
  await sleep();
  require(!mutedButton().disabled, 'Fresh sessions must recover from errors');
  link(false);
  await sleep();
  document.body.dataset.result = 'passed';
}

run().catch(error => {
  document.body.dataset.result = 'failed';
  document.body.dataset.failure = String(error);
});
