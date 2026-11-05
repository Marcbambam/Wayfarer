# Wayfarer Smart Home

Eine selbst gehostete Smart-Home-Zentrale mit Web-Dashboard. Alle Geräte erscheinen an einem Ort, egal von welchem Hersteller, und lassen sich von Handy, Tablet oder PC steuern.

- **Keine Abhängigkeiten:** Node.js 18+ reicht, kein `npm install` nötig
- **Lokal:** Die Geräte werden direkt im Heimnetz angesprochen, ohne Cloud-Zwang
- **Live:** Änderungen erscheinen sofort auf allen geöffneten Geräten (Server-Sent Events)
- **Szenen & Zeitpläne:** z. B. „Guten Morgen“ an Werktagen um 06:45
- **Als App installierbar:** Im Handy-Browser „Zum Startbildschirm hinzufügen“ wählen

## Schnellstart

**Windows:** Node.js (LTS) von https://nodejs.org installieren, dann im Wayfarer-Ordner doppelt auf **`start.cmd`** klicken. Das Dashboard öffnet sich im Browser.

**Aktualisieren (Windows):** doppelt auf **`update.cmd`** klicken. Lädt die neueste Version von GitHub, behält `config.json` und `data` (zusätzlich gesichert im Ordner `sicherung`) und startet die Zentrale neu.

**Mac/Linux:**

```bash
node server.js          # startet im Demo-Modus mit simulierten Geräten
# → http://localhost:8080
```

## Geräte automatisch finden

Öffne das Dashboard, klick auf **⚙︎ → „Netzwerk durchsuchen“**. Die Zentrale fragt jede Adresse im Heimnetz kurz an und zeigt, was sie erkennt:

| Gerät | Erkennung | Übernehmen |
|---|---|---|
| **Shelly** (Gen1–Gen4) | automatisch inkl. Kanälen, Dimmern und Rollladen-Modus | Name und Raum eingeben → „Hinzufügen“ |
| **Tasmota** | automatisch inkl. Dimmer, Farbe und Mehrfachsteckdosen | Name und Raum eingeben → „Hinzufügen“ |
| **Philips Hue Bridge** | automatisch | Link-Taste an der Bridge drücken → „Verbinden“ |
| **Home Assistant** | automatisch (Port 8123) | Zugriffstoken einfügen → „Verbinden“ |
| **LG-Fernseher** (webOS) | automatisch | „Verbinden“ → am Fernseher „Zulassen“ |
| **LUPUS XT2 Plus / XT3 / XT4** | automatisch, sonst per IP-Adresse | Benutzer, Passwort und eigene PIN → „Verbinden“ |

Wird ein Gerät nicht gefunden: **„Gerät wird nicht gefunden? Per IP-Adresse hinzufügen“** im selben Fenster.

Gefundene Geräte werden in `config.json` gespeichert und erscheinen sofort, ohne Neustart. Beim ersten echten Gerät verschwinden die Demo-Geräte.

Das geht auch im Terminal:

```bash
npm run scan                    # eigenes Netz durchsuchen
npm run scan -- 192.168.1.0/24  # bestimmtes Subnetz
```

**Nicht direkt auffindbar** sind Geräte, die nur über die Cloud ihres Herstellers laufen (Alexa, Google Home, Tuya/Smart Life, viele Thermostate und Saugroboter) und Zigbee-/Z-Wave-Geräte ohne eigene IP-Adresse. Diese bindest du über **Home Assistant** ein: Dort einmal die Hersteller verbinden, dann erscheinen sie alle hier.

Läuft die Zentrale in Docker, starte sie mit `network_mode: host`, sonst sieht sie das Heimnetz nicht. Alternativ gibst du das Subnetz im Suchfeld an oder trägst `"scanSubnets": ["192.168.1.0/24"]` in `config.json` ein.

## Manuell einrichten

Alles lässt sich auch direkt in `config.json` eintragen:

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
| `lgtv` | LG-Fernseher mit webOS: An/Aus (Einschalten per Wake-on-LAN), Lautstärke, Play/Pause, aktuelle App | IP-Adresse; Kopplung per Abfrage am Fernseher |
| `homematicip` | Homematic IP mit Access Point (über die Cloud): Heizung je Raum, Türschlossantrieb | Access-Point-ID + blaue Taste |
| `lupus` | LUPUSEC XT2 Plus/XT3/XT4: Scharf (abwesend/zuhause), Unscharf, Tür-/Fensterkontakte | IP-Adresse, Benutzer, Passwort |
| `demo` | Simulierte Geräte zum Ausprobieren | – |

> **Tipp:** Hast du Geräte vieler verschiedener Marken (Alexa-, Google- oder Tuya-Geräte, Thermostate, Saugroboter …), ist **Home Assistant** der einfachste Weg. Dort richtest du die Hersteller einmal ein, und dieses Dashboard zeigt dann alles an.
>
> 📖 **Schritt-für-Schritt-Anleitung für Homematic IP und Dreame-Saugroboter über Home Assistant: [docs/home-assistant.md](docs/home-assistant.md)**

### Home Assistant

1. In Home Assistant: Profil → Sicherheit → *Langlebige Zugriffstoken* → Token erstellen.
2. In `config.json`:

```json
{ "type": "homeassistant", "id": "ha", "url": "http://homeassistant.local:8123", "token": "eyJ…",
  "rooms": { "light.kueche_decke": "Küche" } }
```

Unterstützte Domains: `light`, `switch`, `input_boolean`, `fan`, `climate`, `cover`, `lock` (inkl. „Tür öffnen“), `media_player` (Fernseher, Lautsprecher), `vacuum` (Saugroboter), `alarm_control_panel` (Alarmanlagen), `sensor`, `binary_sensor`.

- **Räume** werden automatisch aus den Bereichen in Home Assistant übernommen.
- **Sensoren:** Standardmäßig kommen nur Temperatur, Luftfeuchte und Tür-/Fensterkontakte mit, die einem Bereich zugeordnet sind. Mit `"sensors": "all"` kommen alle.
- Mit `"domains": [...]` einschränken und mit `"exclude": [...]` einzelne Entitäten weglassen.

### Philips Hue

```bash
npm run hue-pair -- 192.168.1.20   # danach die Link-Taste auf der Bridge drücken
```

Den ausgegebenen Key als `username` eintragen.

### LG-Fernseher

Am einfachsten über die Gerätesuche. Manuell in `config.json` (den `key` bekommst du nur über die Kopplung im Dashboard):

```json
{ "type": "lgtv", "devices": [ { "id": "wz", "name": "Fernseher", "room": "Wohnzimmer", "host": "192.168.1.40", "key": "…", "mac": "aa:bb:cc:dd:ee:ff" } ] }
```

**Einschalten aus dem Standby:** Ein ausgeschalteter LG-Fernseher reagiert nur auf ein Wake-on-LAN-Signal. Dafür am Fernseher **„Über WLAN einschalten“** bzw. **„Mit Mobilgerät einschalten“** aktivieren (*Einstellungen → Allgemein → Geräte → TV-Verwaltung*, je nach Modell auch unter *Netzwerk*). Die MAC-Adresse liest die Zentrale beim Koppeln selbst aus.

### Homematic IP (Access Point)

Der Access Point wird nur über die Homematic-IP-Cloud gesteuert, deshalb findet ihn die Netzwerksuche nicht. Einrichtung im Dashboard: **⚙︎ → „Hier von Hand hinzufügen“ → Homematic IP**
1. Access-Point-ID (SGTIN) vom Aufkleber eintragen, z. B. `3014-F711-A000-0000-0000-0000`.
2. Nur falls in der App vergeben: PIN des Access Points und Berechtigungs-PIN fürs Türschloss eintragen.
3. „Verbinden“ klicken und innerhalb von 2 Minuten die **blaue Taste** am Access Point drücken.

Danach erscheinen die **Heizungen je Raum** (Ist-/Solltemperatur, Luftfeuchte, Fenster offen) und der **Türschlossantrieb** (Verriegeln, Entriegeln, Tür öffnen). Räume werden aus der App übernommen.

- **Inoffizielle Schnittstelle:** dieselbe, die Home Assistant nutzt. eQ-3 kann sie ändern, dann muss die Anbindung angepasst werden.
- Funktioniert nur mit Internetverbindung. Die Zentrale fragt die Cloud höchstens alle 30 Sekunden ab (`"pollSeconds"`), nach einem Befehl kurz öfter.
- **Türschloss:** Kommt beim Schalten eine Meldung zur Berechtigung, muss der neue Zugang „Wayfarer Smart Home“ in der Homematic-IP-App beim Türschlossantrieb unter den Zutrittsberechtigungen freigegeben werden.

### LUPUS-Alarmanlage (XT2 Plus, XT3, XT4)

```json
{ "type": "lupus", "host": "192.168.1.30", "username": "smarthome", "password": "…", "pin": "4711", "room": "Flur" }
```

- Empfehlung: In der LUPUS-Weboberfläche einen **eigenen Benutzer** für die Zentrale anlegen.
- `pin` ist eine PIN, die du selbst festlegst. Das Dashboard fragt danach, bevor es unscharf schaltet. Ohne PIN gibt es nur eine Rückfrage.
- Tür-/Fensterkontakte werden mit angezeigt (`"sensors": false` schaltet das ab).
- **Noch nicht unterstützt:** Erkennen, dass gerade ein Alarm ausgelöst wurde. Dafür weiter die LUPUS-App bzw. Benachrichtigungen der Anlage nutzen.
- Das Passwort steht im Klartext in `config.json`. Setz deshalb unbedingt einen Zugangscode (siehe „Zugriffsschutz“).

### Shelly / Tasmota

Jedes Gerät mit IP-Adresse eintragen (Beispiele in `config.example.json`). Bei Shelly gibt `gen` die Gerätegeneration an (`1` oder `2`) und `kind` die Art: `switch`, `plug`, `light` oder `cover`.

> Gib deinen Geräten im Router feste IP-Adressen, sonst finden sie sich nach einem Neustart nicht mehr.

## Räume, Namen, ausblenden

Am einfachsten direkt im Dashboard: **⋯** auf einer Gerätekarte → Name, Raum, „Im Dashboard ausblenden“. Ausgeblendete Geräte holst du unter **⚙︎** zurück. Die Einstellungen landen in `data/user.json`.

Alternativ in `config.json`. Jedes Gerät hat eine ID der Form `integration:gerät` (in der API unter `/api/devices` sichtbar). Überschreiben kannst du so:

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

**Aktionen:** `turn_on`, `turn_off`, `toggle`, `set_brightness` (0–100), `set_color` (`#rrggbb`), `set_target_temp` (5–35), `set_position` (0–100), `open`, `close`, `stop`, `lock`, `unlock`, `unlatch` (Tür öffnen), `play`, `pause`, `set_volume` (0–100), `start`, `return_to_base`, `locate` (Saugroboter), `arm_away`, `arm_home`, `arm_night`, `disarm` (Alarmanlage, `value` = Code)

> **Sicherheitsregel:** `unlock`, `unlatch` und `disarm` sind nie als Gruppenbefehl erlaubt (`room`/`type`), nur mit `device` für ein bestimmtes Gerät. „Szene aus aktuellem Zustand“ übernimmt bei Schlössern nur „verriegeln“ und bei Alarmanlagen nur „scharf schalten“.

## Zeitpläne

```json
"automations": [
  { "name": "Wecken", "at": "06:45", "days": [1, 2, 3, 4, 5], "scene": "guten-morgen" },
  { "name": "Kaffee aus", "at": "10:00", "actions": [{ "device": "shelly:kaffee", "action": "turn_off" }] }
]
```

`days`: 1 = Montag … 7 = Sonntag. Ohne `days` läuft der Zeitplan täglich. Es gilt die Uhrzeit des Rechners, auf dem der Server läuft.

## Zugriffsschutz

Im Dashboard unter **⚙︎ → Zugangscode** festlegen. Alternativ `"token"` in `config.json` oder die Umgebungsvariable `SMARTHOME_TOKEN` setzen. Das Dashboard fragt dann einmal nach dem Code und merkt ihn sich. **Gib den Server nicht ungeschützt ins Internet frei.** Für Zugriff von unterwegs eignen sich ein VPN (WireGuard, Tailscale) oder ein Reverse-Proxy mit HTTPS.

## REST-API

Alle Endpunkte verlangen `Authorization: Bearer <token>`, wenn ein Token gesetzt ist.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/devices` | Alle Geräte mit Zustand |
| POST | `/api/devices/:id/command` | `{ "action": "turn_on" }` |
| PATCH | `/api/devices/:id` | Im Dashboard umbenennen/verschieben/ausblenden: `{ "name", "room", "hidden" }` |
| POST | `/api/command` | Gruppenbefehl: `{ "room": "Küche", "type": "light", "action": "turn_off" }` |
| GET / POST | `/api/scenes` | Szenen auflisten / anlegen (`{ name, actions }` oder `{ name, capture: [ids] }`) |
| POST | `/api/scenes/:id/run` | Szene ausführen |
| DELETE | `/api/scenes/:id` | Selbst angelegte Szene löschen |
| POST | `/api/discover` | Netzwerk durchsuchen (`{ "subnet": "192.168.1.0/24" }` optional) |
| POST | `/api/setup/devices` · `/api/setup/hue` · `/api/setup/homeassistant` | Gefundene Geräte übernehmen |
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
