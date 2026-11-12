# Privacy

Aangan is offline by default and does not collect or send hardware information
or usage data. When the user chooses **Refresh catalog** and consents to the
request, the desktop app contacts only `raw.githubusercontent.com` to download
the public model catalog and its Minisign signature. The user can allow one
refresh or choose to always allow refreshes in Settings. The app verifies the
signature locally before using the catalog. No information about the PC is sent.

The bundled catalog remains available offline. See
[Catalog signing](./CATALOG-SIGNING.md) for the signing and key-storage process.

Offline mode in Settings blocks new network requests and cancels in-progress
requests, even when catalog refresh consent has been saved. Recent network
activity is kept in memory on the PC only and is cleared when Aangan closes.
The Network access details link opens [the network policy](./NETWORK.md) in the
system browser after the user selects it; that browser request is outside
Aangan's in-app activity log. The policy lists all gate-allowed hosts and
identifies which downloader/runtime hosts are reserved for future features.
The chip and activity log cover Aangan's gated requests only, not other
applications' traffic. Aangan does not launch a local runtime yet; planned
runtime support will be restricted to loopback and will not make outbound
requests.
