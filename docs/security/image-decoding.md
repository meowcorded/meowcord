# Image decoding limits

The server decodes images itself for branding output and burst reaction palettes. These limits bound the input it accepts before decoding. They are separate logical budgets, not a total process memory limit.

## Branding images

Remote branding-image downloads have an 8 MiB body ceiling and a five-second deadline, including body consumption. Oversized and failed responses are cancelled and normal branding fallbacks remain available. The remote data-URI and PNG caches each retain at most 16 entries and admit four distinct jobs; repeated keys share pending work and only completed entries are evicted. Fallback PNG rendering shares its cache admission budget. Local data-URI embedding and PNG rendering also read files through the 8 MiB ceiling and close rejected file streams. Local data-URI work shares cache admission, with file identity and timestamps in the key to refresh changed files. PNG source dimensions are checked before decoding: at most 8,192 pixels per side and 16,777,216 total pixels. Rejected sources keep the default-image fallback. These limits bound source bytes, job counts and nominal raster dimensions, not decoder overhead or total process memory.

Local branding PNG cache keys and public icon and wordmark versions include file identity, modification time, change time and size. Replacing a configured file at the same path refreshes these versions and rendered PNGs. Unchanged files keep stable versions. Remote versions continue to use the configured URL.

## Email images

`/static/email/icon.png` and `/static/email/wordmark.png` read their source through the same 8 MiB ceiling and five-second deadline. A PNG source is served unchanged and is never decoded. Any other format is decoded by sharp with a 16,777,216-pixel input limit and a five-second processing timeout, reading only the first frame of an animation, then resized to fit inside 144 pixels for the icon and 800 pixels for the wordmark. The rendered PNGs have their own cache of 16 entries that admits four distinct jobs. A failed or rejected source is served as the configured image without conversion.

## Burst reaction palettes

Burst reaction palette work admits at most 32 distinct jobs per process and retains up to 1,024 cache entries. Repeated keys share accepted work, only completed least-recently-used entries are evicted, and overload uses deterministic fallback colors without starting another job. Settlement restores admission. Source response bytes, decoder allocations and duplicate request waiters are outside this distinct-job limit.

## GIF and palette sources

Server-side PNG branding rendering also checks GIF frame dimensions before decoding and rejects sources with more than 256 frames. Raw data-URI embedding retains its existing byte limit. Burst reaction palette extraction uses stricter 1 MiB, 1,024-pixel side and 1,048,576-pixel limits plus a 1.5-second remote body deadline; rejected inputs use fallback colors. These derived-image limits do not change emoji delivery.

## TIFF and JPEG

Classic TIFF admission checks every linked page before PNG branding rendering or burst palette decoding. Page pixels share one selected pixel budget, and tile buffers share a separate budget with the same ceiling. Linked directories stop at 256 pages and 4,096 entries; linked-page numeric tag arrays stop at 65,536 values and linked-page tag payloads at 8 MiB. Cyclic, truncated or invalid directories use the existing fallback. BigTIFF remains unsupported by the current renderer and is rejected before decoder admission. These checks do not bound nested and vendor metadata parsing or compression-specific decoder overhead.

TIFF JPEG admission checks the embedded frame dimensions used by modern strips, shared tables and legacy interchange data before calling the decoder. Embedded rasters share the selected pixel budget, and repeated encoded strip/table input stops at 8 MiB per source. JPEG precision is limited to 1 through 16 bits, component count to 1 through 4, and horizontal and vertical sampling factors to 1 through 4. Rejected sources retain fallback colors or default branding output. This does not bound other TIFF compression modes, nested metadata parsing or total decoder memory.

TIFF page and tile byte buffers each share a ceiling of eight bytes per selected pixel across linked pages. Sample depth must fit 1 through 32 bits and sample count 1 through 8; the RAW CFA and Canon pitch overrides are included in byte accounting. Deflate and Adobe Deflate strips stream into a counter with at most 16 KiB output chunks. Expansion beyond the destination buffer capacity rejects before rendering, and accepted expansion bytes share the same per-source ceiling. JPEG and Deflate also share the 8 MiB repeated encoded-input ceiling. At default branding limits each byte budget is 128 MiB; burst palettes use 8 MiB. These are separate logical budgets, not a total process memory limit. Nested metadata, other codecs and filesystem open/stat stalls remain under audit.

## Local files

Local image reads open with nonblocking flags and accept only regular files, including symlinks whose opened target is a regular file. Pipes, devices and directories reject before stream creation. The selected deadline aborts the file stream, with a five-second branding default and a 1.5-second palette limit; every path closes its owned descriptor. A deadline cannot guarantee cancellation of an operating-system open or stat call stalled on a filesystem.
