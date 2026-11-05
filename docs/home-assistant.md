# Deine Geräte über Home Assistant einbinden

Diese Anleitung bindet **Homematic-IP-Heizung und -Türschlossantrieb sowie den Dreame-Saugroboter** an. Home Assistant spricht mit den Geräten, und das Wayfarer-Dashboard zeigt sie alle an einem Ort an.

> **LG-Fernseher, LUPUS-Alarmanlage und Homematic IP brauchen kein Home Assistant mehr.** Die bindet das Dashboard direkt ein: **⚙︎ → „Netzwerk durchsuchen“** (siehe README). Die Abschnitte dazu weiter unten sind nur für den Fall gedacht, dass du sie trotzdem lieber über Home Assistant laufen lässt.

```
Geräte  ──►  Home Assistant  ──►  Wayfarer-Dashboard (Handy, PC, Tablet)
```

## 1. Home Assistant installieren

Home Assistant muss **rund um die Uhr laufen**, sonst funktionieren Zeitpläne und Fernsteuerung nicht. Drei Möglichkeiten:

| Variante | Aufwand | Kosten |
|---|---|---|
| **Home Assistant Green**: fertiges Kästchen, einstecken, fertig | am einfachsten | ca. 100 € |
| **Raspberry Pi 4 oder 5** mit „Home Assistant OS“ | mittel | ca. 80–120 € |
| Auf einem Windows-PC in **VirtualBox** | mittel, PC muss immer an sein | kostenlos |

Installationsanleitungen: https://www.home-assistant.io/installation/

Danach ist Home Assistant im Browser unter **http://homeassistant.local:8123** erreichbar. Lege dort dein Benutzerkonto an.

> Tipp: Die Wayfarer-Zentrale kann auf demselben Gerät mitlaufen oder weiter auf deinem PC. Beides funktioniert.

## 2. Räume anlegen

In Home Assistant: **Einstellungen → Bereiche, Labels & Zonen**. Leg deine Räume an (Wohnzimmer, Flur, …) und ordne die Geräte später zu. Das Wayfarer-Dashboard **übernimmt diese Räume automatisch**.

## 3. Geräte verbinden

Alle Integrationen fügst du so hinzu: **Einstellungen → Geräte & Dienste → „+ Integration hinzufügen“** und dann nach dem Namen suchen.

### LG-Fernseher (webOS): optional, geht auch direkt

1. Fernseher einschalten.
2. Integration **„LG webOS TV“** hinzufügen. Meist wird der Fernseher schon automatisch vorgeschlagen.
3. Auf dem Fernseher erscheint eine Abfrage: **„Zulassen“** wählen.

**Einschalten aus dem ausgeschalteten Zustand:** Ein ausgeschalteter LG-Fernseher hört nicht auf Befehle. Damit er sich einschalten lässt:
- Am Fernseher unter *Einstellungen → Allgemein → Geräte → TV-Verwaltung* (je nach Modell auch *Netzwerk*) **„Über WLAN einschalten“** bzw. **„Mit Mobilgerät einschalten“** aktivieren.
- In Home Assistant eine Automation anlegen. Auslöser: Gerät *Fernseher* → **„Gerät wird zum Einschalten aufgefordert“**. Aktion: **„Wake on LAN: Magic Packet senden“** mit der MAC-Adresse des Fernsehers. Die MAC-Adresse steht am Fernseher unter Netzwerk → Verbindungsdetails.

Ausschalten, Lautstärke und Pause funktionieren auch ohne diesen Schritt.

### Homematic IP: Heizung und Türschlossantrieb (optional, geht auch direkt)

1. Integration **„HomematicIP Cloud“** hinzufügen.
2. **Access-Point-ID** (SGTIN) eintragen. Sie steht auf dem Aufkleber auf der Rückseite des Access Points, z. B. `3014-F711-A000-0000-0000-0000`. Die PIN brauchst du nur, wenn du in der App eine vergeben hast.
3. Wenn Home Assistant dazu auffordert, die **blaue Taste am Access Point** drücken.

Danach erscheinen die Heizkörperthermostate bzw. Wandthermostate als Heizung und der Türschlossantrieb als Schloss.

Im Dashboard hat das Schloss drei Knöpfe:
- **Verriegeln**
- **Entriegeln**, mit Rückfrage
- **„Tür öffnen“** zieht die Falle zurück, ebenfalls mit Rückfrage.

### LUPUS-Alarmanlage: optional, geht auch direkt

1. Integration **„Lupus Electronics LUPUSEC“** hinzufügen.
2. IP-Adresse der Alarmzentrale, Benutzername und Passwort eintragen.

> **Ehrlicher Hinweis:** Die Home-Assistant-Integration ist vor allem für die Modelle XT1 und XT2 bekannt. Ob sie mit XT2 Plus, XT3 oder XT4 vollständig funktioniert, ist nicht sicher. Wenn die Anlage nicht erscheint oder sich nicht schalten lässt, sag Bescheid. Dann baue ich eine direkte LUPUS-Anbindung ins Dashboard ein.

Empfehlung: Leg in der LUPUS-Weboberfläche einen **eigenen Benutzer** für Home Assistant an, statt den Administrator zu verwenden.

Im Dashboard schaltest du die Anlage auf **Abwesend** oder **Zuhause** scharf. **Unscharf** geht nur mit Code bzw. Rückfrage.

### Dreame-Saugroboter

Für Dreame gibt es keine offizielle Integration, aber eine verbreitete Community-Integration:

1. **HACS** installieren (Community-Store für Home Assistant): https://hacs.xyz/docs/use/
2. In HACS nach **„Dreame Vacuum“** suchen und installieren, dann Home Assistant neu starten.
3. Integration **„Dreame Vacuum“** hinzufügen und dich mit deinem **Dreamehome- bzw. Xiaomi-Konto** anmelden.

Im Dashboard: **Saugen / Pause / Zur Station** mit Akkuanzeige.

> Die Dreame-Integration legt viele Zusatz-Schalter an (Kindersicherung, Teppichmodus, …). Was du nicht brauchst, blendest du im Dashboard über **⋯ → „Im Dashboard ausblenden“** aus.

## 4. Mit dem Wayfarer-Dashboard verbinden

1. In Home Assistant links unten auf dein **Profil** → Reiter **Sicherheit** → ganz unten **„Langlebige Zugriffstoken“ → „Token erstellen“**. Namen eingeben, z. B. „Wayfarer“, und den Token kopieren. Er wird nur einmal angezeigt.
2. Im Wayfarer-Dashboard: **⚙︎ → „Netzwerk durchsuchen“**. Home Assistant wird gefunden.
3. Token einfügen → **„Verbinden“**.

Alle Geräte erscheinen nach ein paar Sekunden, sortiert nach deinen Räumen.

## Sicherheit

Weil Türschloss und Alarmanlage dranhängen:

- **Zugangscode setzen:** In der Datei `config.json` der Zentrale `"token": "ein-langes-geheimes-wort"` eintragen. Das Dashboard fragt dann einmal danach.
- **Nicht ins Internet freigeben.** Für unterwegs ein VPN nutzen. Viele Router können das, z. B. die Fritz!Box mit WireGuard.
- Entriegeln, Tür öffnen und Unscharf schalten funktionieren aus Sicherheitsgründen **nie über Szenen oder Gruppenbefehle** wie „alles im Flur“, sondern nur einzeln am Gerät.
