# Telnet Video Stream Server

Stream video to a terminal over Telnet using ASCII or 24‑bit truecolor blocks.

---

## Requirements

* Node.js (>= 18 recommended)
* ffmpeg installed and available in PATH

Install dependencies:

```bash
npm install minimist pino pino-pretty
```

---

## Photos

<img width="1163" height="680" alt="image" src="https://github.com/user-attachments/assets/13540084-93b6-4654-8945-61272401208c" />

<img width="1183" height="701" alt="image" src="https://github.com/user-attachments/assets/06890d4b-26e5-4a4d-8991-2d17c927d8f5" />

<img width="1280" height="709" alt="image" src="https://github.com/user-attachments/assets/7a769cc5-59ed-474b-b78d-165c581fd329" />

---

## Folder Structure

If no video is provided, all videos inside:

```
./videos
```

are played recursively in alphabetical order.

Supported formats:

* .mp4
* .mkv
* .webm
* .mov
* .avi

---

## Run

### Play specific video

```bash
node app.js -v path/to/video.mp4
```

### Play all videos in ./videos

```bash
node app.js
```

---

## CLI Options

| Flag         | Description         | Default       |
| ------------ | ------------------- | ------------- |
| -p, --port   | Server port         | 2323          |
| -f, --fps    | Output FPS          | 15            |
| -w, --width  | Base render width   | 240           |
| -h, --height | Base render height  | 135           |
| -v, --video  | Specific video file | playlist mode |

Example:

```bash
node app.js -p 4000 -f 30 -w 320 -h 180
```

---

## Connect

From another terminal or machine:

```bash
telnet <SERVER_IP> 2323
```

---

## Controls (Client Side)

| Key | Action                   |
| --- | ------------------------ |
| m   | Toggle ASCII / Truecolor |
| q   | Quit                     |

Press ENTER key after each key.

---

## Notes

* Multiple clients are supported simultaneously.
* Rendering is per-client (each can have different terminal size and mode).
* ffmpeg output is hidden unless an error occurs.
* Logging is minimal, colorful, and timestamped.

---

## Stop Server

Press:

```bash
Ctrl + C
```

Server will shut down cleanly and restore cursor state.
