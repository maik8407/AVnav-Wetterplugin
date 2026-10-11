# radaroverlay – Wetterradar als Karten-Overlay

Dieses Plugin für [AvNav](https://github.com/wellenvogel/avnav) bringt drei "Karten" mit, die aktuelle Niederschlags-Radardaten
anzeigen. Sie werden nicht allein genutzt, sondern als **Overlay** über eine
vorhandene Seekarte gelegt.

| Karte | Quelle | Abdeckung | Aktualisierung | Auflösung |
| --- | --- | --- | --- | --- |
| `radar-rainviewer` | [RainViewer](https://www.rainviewer.com/api.html) | weltweit (wo es Radar gibt) | alle 10 min | grob (Daten bis Zoom 7, bis Zoom 15 vergrößert) |
| `radar-knmi` | [KNMI](https://dataplatform.knmi.nl/dataset/radar-reflectivity-composites-2-0) (WMS, Layer `precipitation`, CC BY 4.0) | Niederlande, IJsselmeer, Waddenzee | alle 5 min | ca. 1 km |
| `radar-dwd` | [Deutscher Wetterdienst](https://www.dwd.de/DE/leistungen/geodienste/geodienste.html) (WMS, Layer `dwd:Niederschlagsradar`) | Deutschland und Nachbarländer, Nord- und Ostsee küstennah | alle 5 min | ca. 1 km |

Windy bietet Radardaten in seiner API nicht an (Radar ist dort kein erlaubtes
Overlay), deshalb werden freie Quellen genutzt. Die RainViewer-API ist nur für
private Nutzung freigegeben (max. 100 Anfragen pro Minute und IP).

**Voraussetzung**: eine AvNav Version, die `plugin.mjs`, Karten in `plugin.json` und
`registerUserMapLayer` unterstützt (AvNav-beta, daily build ab 20260827).
Die Release-Version 20250822 kann das noch nicht.

### KNMI und API-Key

Ohne Key nutzt `radar-knmi` den anonymen Zugang der KNMI Data Platform. Der ist
auf 1 Anfrage pro Sekunde begrenzt (die Radarbilder erscheinen daher nacheinander)
und hat ein Stundenkontingent, das sich alle anonymen Nutzer teilen.
Mit einem kostenlosen eigenen Key (Registrierung im
[KNMI Developer Portal](https://developer.dataplatform.knmi.nl/apis/), "Request API Key"
für die WMS API) geht es schneller und zuverlässiger. Der Key wird im Radar-Dialog
(Button "Radar" auf der Navigationsseite) eingetragen. Benötigt wird der Key für die **WMS API**.
Lehnt der Browser die Anfragen mit Key ab, nutzt das Plugin automatisch wieder den anonymen Zugang.

## Installation

1. Die fertige Zip aus [`dist/`](dist/) herunterladen (oder selbst bauen: `./build.sh` erzeugt `radaroverlay-<version>.zip`).
2. In AvNav: Hauptmenü -> Plugins -> Upload -> Zip auswählen. Das Plugin erscheint als `user-radaroverlay`.
3. AvNav einmal neu laden (bzw. die App neu öffnen).

## Nutzung

1. Auf der Navigationsseite den Karten-Button öffnen und bei der Seekarte rechts den Overlay-Button antippen.
2. Im Edit-Overlay Dialog "Insert After" wählen, die Option "chart" anklicken und unter "name" `radar-dwd` oder `radar-rainviewer` auswählen.
3. Die `opacity` auf z.B. 0.6 stellen, damit die Seekarte sichtbar bleibt, und speichern.
4. Über "Hide Overlays"/"Show Overlays" in der Kartenliste lässt sich das Radar schnell aus- und einblenden.

Neue Radardaten werden automatisch im Hintergrund nachgeladen. Ohne
Internetverbindung bleibt das Overlay einfach leer.

## Animation und Vorhersage

Sobald ein Radar-Overlay aktiv ist, erscheint auf der Navigationsseite der Button "Radar".
Im Dialog kann man die Animation einschalten und einstellen, wie viele Minuten
Vergangenheit und Vorhersage gezeigt werden und wie schnell sie läuft (Sekunden pro Bild, Standard 2). Während der
Animation steht oben mittig auf der Seekarte (unter den Anzeigen, neben dem Kompass), welcher Zeitpunkt gerade zu sehen ist
(z.B. `−30 min 15:40`, `jetzt 16:10`, `+30 min 16:40 Vorhersage` – Vorhersagen orange).

* DWD: Vergangenheit aus `dwd:Niederschlagsradar`, Vorhersage (bis 120 min) aus `dwd:Radar_wn-product_1x1km_ger`.
* KNMI: Vergangenheit aus `precipitation`, Vorhersage (bis 120 min) aus dem Dataset `radar_forecast`, Layer `precipitationfc`.
* RainViewer: nur Vergangenheit.

### Wind

Unter der Zeit steht der vorhergesagte Wind mit Böen (in Knoten) am Bootsort für den gerade
gezeigten Zeitpunkt, z.B. `SW 14 kn, Böen 22`. Ohne GPS-Fix wird die Kartenmitte genommen.
Ohne Animation wird nur der aktuelle Wind angezeigt. Die Daten kommen von
[Open-Meteo](https://open-meteo.com) (frei für private Nutzung, 15-Minuten-Werte) und werden
alle 15 Minuten oder nach ca. 5 km Fahrt neu geladen. Abschaltbar im Radar-Dialog ("Wind anzeigen").

Im Nachtmodus wird die Anzeige dunkel mit roter Schrift dargestellt, das Radar selbst wird wie die Seekarte abgedunkelt.

Die Radarbilder werden im Hintergrund nachgeladen, ohne die Seekarte neu aufzubauen.

## Weitere Quellen

Jede Quelle ist in `plugin.mjs` ein Eintrag in `SOURCES` (Profil `plugin_<name>`)
plus eine Karte in `plugin.json`. Für eine neue Quelle beides ergänzen.
