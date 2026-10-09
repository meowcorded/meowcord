# pion-sfu

Selective forwarding unit for voice, video and Go Live, vendored from [spacebarchat/pion-webrtc](https://github.com/spacebarchat/pion-webrtc) (AGPL-3.0). The voice gateway in `src/webrtc` talks to it over a unix socket.

Build it with Go 1.24 or newer:

```sh
cd extra/pion-sfu && go build -o pion-sfu .
```

Then point the server at the binary in `.env`:

```sh
PION_SFU_BIN=/path/to/extra/pion-sfu/pion-sfu
WRTC_PUBLIC_IP=203.0.113.10
WRTC_PORT_MIN=5000
```

The server starts the SFU itself, restarts it if it exits, and connects to it on `/tmp/spacebar-sfu-<WRTC_PORT_MIN>.sock` (override with `PION_SFU_IPC`). Media uses a single UDP port, `WRTC_PORT_MIN`. Set `PION_SFU_VERBOSE=1` to print the SFU log with pion debug output.

Without `PION_SFU_BIN` and with `PION_SFU_IPC` set, the server connects to an SFU started separately on that socket instead. When that SFU goes away, the server closes the running voice connections and keeps reconnecting until a new one listens. The SFU and the server must agree on `WRTC_PUBLIC_IP` and the port, which `WRTC_PORT_MIN` gives the server and `-port` gives the SFU. `WRTC_PUBLIC_IP` and `-ip` take an IPv4 address or a host name, which each side resolves to its IPv4 address once when it starts. `docker-compose.yml` at the repository root runs it this way, see `docs/self-hosting/deploy.md`.

Changes from upstream: the IPC socket path is a flag (`-ipc`) so several servers can run on one machine, and pion logging defaults to warnings.

## Server mute, deafen and stage suppression

The voice gateway sends a `moderate` message whenever a user's voice state changes, with `blockAudio` (server mute or stage suppression), `blockVideo` (suppressed in a stage) and `deaf` (server deafen). The SFU then drops that publisher's blocked tracks before they reach the packet cache, so neither forwarding nor retransmission can leak them, and stops sending any audio to a deafened subscriber. This holds even when a modified client keeps sending media.

## Loss recovery and bandwidth

Every published track is forwarded with its original SSRC, so the SFU handles retransmission itself instead of using pion's stock NACK interceptors:

- Upstream, the SFU tracks sequence numbers per publisher SSRC and sends NACKs for gaps (first after 10 ms, then every 100 ms, at most 8 times or for 1 s). Video retransmissions arrive on the publisher's RTX SSRC and are unwrapped back into the media stream. Audio retransmissions arrive on the media SSRC, since the client negotiates NACK for Opus without RTX.
- Downstream, the last 2048 video and 512 audio packets of each publisher are cached. A subscriber's NACK is answered from that cache, as RTX on `ssrc + 1` (the SSRC the client puts in its FID group) for video, and on the media SSRC for audio.
- Subscribers address their RTCP to the publisher SSRCs they receive, which pion does not route to any sender. For each subscription the SFU opens an RTP receiver on the subscriber's transport for those SSRCs, which only reads RTCP: NACK, PLI, FIR, receiver reports and REMB.
- Transport-wide sequence numbers are rewritten on each subscriber leg, and the SFU sends transport-cc feedback to publishers, so each publisher's own congestion control works against the SFU.
- Once a second the SFU sends each video publisher a REMB. Each subscriber's loss for that video comes from the cumulative lost count and highest sequence number in its receiver reports, measured over the last second and smoothed, because Chrome sends several reduced-size reports a second and their fraction-lost field is too noisy to act on. The REMB is 10 Mbps until the worst subscriber's loss passes 10%, then the cap drops to the publisher's bitrate times `1 - loss / 2` (not below 150 kbps). It rises 8% a second while every subscriber stays under 2% loss, and REMB values that subscribers send are honoured too. The SFU does not run a delay-based estimator per subscriber: pion's GCC fell from 20 Mbps to 100 kbps on an idle loopback call, which would have throttled publishers for nothing.

Header extension IDs are remapped by URI between the publisher's and each subscriber's negotiation, so clients with different extmap IDs interoperate.

The client never offers simulcast: the web client adds a single video sender without `sendEncodings`, so every publisher has one video SSRC.

## Testing loss recovery

`-drop-in <percent>` drops that share of incoming RTP and `-drop-out <percent>` drops outgoing RTP at the UDP socket, before SRTP, so it looks like network loss to both ends. Pass extra flags through `PION_SFU_ARGS`, and set `PION_SFU_LOG=1` to print the SFU log (including a stats line per track every 10 s) without pion's debug output:

```sh
PION_SFU_ARGS="-drop-out 5" PION_SFU_LOG=1 PORT=3001 scripts/dev/restart.sh
bun scripts/dev/voice-probe.mjs --port 3001 --video --drop-voice
```
