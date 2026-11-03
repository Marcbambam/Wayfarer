# Wayfarer Smart Home

Eine selbst gehostete Smart-Home-Zentrale mit Web-Dashboard. Alle Geräte erscheinen an einem Ort, egal von welchem Hersteller, und lassen sich von Handy, Tablet oder PC steuern.

- **Keine Abhängigkeiten:** Node.js 18+ reicht, kein `npm install` nötig
- **Lokal:** Die Geräte werden direkt im Heimnetz angesprochen, ohne Cloud-Zwang
- **Live:** Änderungen erscheinen sofort auf allen geöffneten Geräten (Server-Sent Events)
- **Szenen & Zeitpläne:** z. B. „Guten Morgen“ an Werktagen um 06:45
- **Als App installierbar:** Im Handy-Browser „Zum Startbildschirm hinzufügen“ wählen

## Schnellstart

```bash
node server.js          # startet im Demo-Modus mit simulierten Geräten
# → http://localhost:8080
```

Für deine echten Geräte:

```bash
cp config.example.json config.json
# config.json anpassen (siehe unten), dann:
npm start
```

## Unterstützte Integrationen

| Typ | Was damit geht | Benötigt |
|---|---|---|
| `homeassistant` | **Alles, was Home Assistant kennt**: Zigbee, Z-Wave, Matter/Thread, Sonos, Tado, Nest, Fritz!DECT, IKEA, Xiaomi, Tuya usw. | URL + langlebiger Zugriffstoken |
| `hue` | Philips-Hue-Lampen und -Stecker inkl. Farbe, Räume werden übernommen | Bridge-IP + API-Key |
| `shelly` | Shelly-Relais, -Steckdosen, -Dimmer und -Rollladen (Gen1 und Gen2/Plus/Pro) | IP-Adresse je Gerät |
| `tasmota` | Geräte mit Tasmota-Firmware (Steckdosen, LED-Strips, Lampen) | IP-Adresse je Gerät |
| `webhook` | Alles mit HTTP-Schnittstelle: ESPHome, Node-RED, IFTTT, Eigenbau | URL pro Aktion |
| `demo` | Simulierte Geräte zum Ausprobieren | – |

> **Tipp:** Hast du Geräte vieler verschiedener Marken (Alexa-, Google- oder Tuya-Geräte, Thermostate, Saugroboter …), ist **Home Assistant** der einfachste Weg. Dort richtest du die Hersteller einmal ein, und dieses Dashboard zeigt dann alles an.

### Home Assistant

1. In Home Assistant: Profil → Sicherheit → *Langlebige Zugriffstoken* → Token erstellen.
2. In `config.json`:

```json
{ "type": "homeassistant", "id": "ha", "url": "http://homeassistant.local:8123", "token": "eyJ…",
  "rooms": { "light.kueche_decke": "Küche" } }
```

Unterstützte Domains: `light`, `switch`, `input_boolean`, `fan`, `climate`, `cover`, `lock`, `media_player`, `sensor`, `binary_sensor`. Mit `"domains": [...]` einschränken und mit `"exclude": [...]` einzelne Entitäten ausblenden.

### Philips Hue

```bash
npm run hue-pair -- 192.168.1.20   # danach die Link-Taste auf der Bridge drücken
```

Den ausgegebenen Key als `username` eintragen.

### Shelly / Tasmota

Jedes Gerät mit IP-Adresse eintragen (Beispiele in `config.example.json`). Bei Shelly gibt `gen` die Gerätegeneration an (`1` oder `2`) und `kind` die Art: `switch`, `plug`, `light` oder `cover`.

> Gib deinen Geräten im Router feste IP-Adressen, sonst finden sie sich nach einem Neustart nicht mehr.

## Räume, Namen, ausblenden

Jedes Gerät hat eine ID der Form `integration:gerät` (in der API unter `/api/devices` sichtbar). Überschreiben kannst du so:

```json
"devices": {
  "hue:3": { "name": "Sofalampe", "room": "Wohnzimmer" },
  "ha:sensor.sun_next_dawn": { "hidden": true }
}
```

## Szenen

Szenen werden entweder in `config.json` definiert oder direkt im Dashboard angelegt („+ Szene aus aktuellem Zustand“: Geräte einstellen, auswählen, speichern). Eine Aktion zielt auf ein einzelnes Gerät (`device`) oder auf eine Gruppe (`room` und/oder `type`):

```json
{ "id": "filmabend", "name": "Filmabend", "icon": "🎬", "actions": [
  { "room": "Wohnzimmer", "type": "light", "action": "set_brightness", "value": 15 },
  { "device": "hue:1", "action": "set_color", "value": "#6c5ce7" }
]}
```

**Aktionen:** `turn_on`, `turn_off`, `toggle`, `set_brightness` (0–100), `set_color` (`#rrggbb`), `set_target_temp` (5–35), `set_position` (0–100), `open`, `close`, `stop`, `lock`, `unlock`, `play`, `pause`, `set_volume` (0–100)

## Zeitpläne

```json
"automations": [
  { "name": "Wecken", "at": "06:45", "days": [1, 2, 3, 4, 5], "scene": "guten-morgen" },
  { "name": "Kaffee aus", "at": "10:00", "actions": [{ "device": "shelly:kaffee", "action": "turn_off" }] }
]
```

`days`: 1 = Montag … 7 = Sonntag. Ohne `days` läuft der Zeitplan täglich. Es gilt die Uhrzeit des Rechners, auf dem der Server läuft.

## Zugriffsschutz

Setze `"token"` in `config.json` oder die Umgebungsvariable `SMARTHOME_TOKEN`. Das Dashboard fragt dann einmal nach dem Code und merkt ihn sich. **Gib den Server nicht ungeschützt ins Internet frei.** Für Zugriff von unterwegs eignen sich ein VPN (WireGuard, Tailscale) oder ein Reverse-Proxy mit HTTPS.

## REST-API

Alle Endpunkte verlangen `Authorization: Bearer <token>`, wenn ein Token gesetzt ist.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/devices` | Alle Geräte mit Zustand |
| POST | `/api/devices/:id/command` | `{ "action": "turn_on" }` |
| POST | `/api/command` | Gruppenbefehl: `{ "room": "Küche", "type": "light", "action": "turn_off" }` |
| GET / POST | `/api/scenes` | Szenen auflisten / anlegen (`{ name, actions }` oder `{ name, capture: [ids] }`) |
| POST | `/api/scenes/:id/run` | Szene ausführen |
| DELETE | `/api/scenes/:id` | Selbst angelegte Szene löschen |
| GET | `/api/status` | Zustand der Integrationen und Zeitpläne |
| GET | `/api/events` | Live-Stream (Server-Sent Events) |

Beispiel für Kurzbefehle auf dem iPhone oder einen Sprachassistenten:

```bash
curl -X POST http://zentrale:8080/api/scenes/gute-nacht/run -H "Authorization: Bearer GEHEIM"
```

## Dauerhaft betreiben (z. B. Raspberry Pi)

```ini
# /etc/systemd/system/smarthome.service
[Unit]
Description=Wayfarer Smart Home
After=network-online.target

[Service]
WorkingDirectory=/home/pi/Wayfarer
ExecStart=/usr/bin/node server.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now smarthome
```

## Eigene Integration schreiben

Neue Datei in `src/adapters/`, von `Adapter` erben, `discover()` (liefert Geräte) und `execute(id, befehl)` implementieren und in `src/adapters/index.js` registrieren. `demo.js` ist das einfachste Beispiel.

## Tests

```bash
npm test
```
