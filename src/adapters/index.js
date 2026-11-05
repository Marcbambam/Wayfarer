import { DemoAdapter } from './demo.js';
import { HomeAssistantAdapter } from './homeassistant.js';
import { HueAdapter } from './hue.js';
import { ShellyAdapter } from './shelly.js';
import { TasmotaAdapter } from './tasmota.js';
import { WebhookAdapter } from './webhook.js';
import { LgTvAdapter } from './lgtv.js';
import { LupusAdapter } from './lupus.js';
import { HomematicIpAdapter } from './homematicip.js';

export const ADAPTERS = {
  demo: DemoAdapter,
  homeassistant: HomeAssistantAdapter,
  hue: HueAdapter,
  shelly: ShellyAdapter,
  tasmota: TasmotaAdapter,
  webhook: WebhookAdapter,
  lgtv: LgTvAdapter,
  lupus: LupusAdapter,
  homematicip: HomematicIpAdapter,
};

export function createAdapter({ type, id, ...config }) {
  const Cls = ADAPTERS[type];
  if (!Cls) throw new Error(`Unbekannter Integrationstyp "${type}". Verfügbar: ${Object.keys(ADAPTERS).join(', ')}`);
  return new Cls(id ?? type, config);
}
