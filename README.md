# Image & Video Converter

**Free online converter** — Convert images and videos between formats. JPEG, PNG, WebP, AVIF, MP4, WebM, GIF. Adjustable quality and dimensions.

**[Use it now → convert.purvanas.fr](https://convert.purvanas.fr)**

## Features

- **Image conversion**: JPEG, PNG, WebP, AVIF, GIF, BMP, TIFF
- **Video conversion**: MP4, WebM, GIF
- **Adjustable quality**: choose compression level
- **Resize**: custom dimensions with aspect ratio lock
- **Batch conversion**: convert multiple files at once
- **No account required**: upload, convert, download
- **Privacy**: files are processed on the server and deleted after conversion

## Tech Stack

- **Backend**: Node.js, Express, Sharp (images), FFmpeg (video)
- **Frontend**: Vanilla HTML/CSS/JS
- **Hosting**: Self-hosted on Ubuntu Server

## Self-hosting

```bash
git clone https://github.com/Purvanas/image-converter.git
cd image-converter
npm install
# Make sure ffmpeg is installed on your system
node server.js
```

Runs on port 3400 by default.

## License

MIT

## Links

- **Live demo**: [convert.purvanas.fr](https://convert.purvanas.fr)
- **Author**: [Purvanas](https://purvanas.fr)
- **Other tools**: [Universal Downloader](https://dl.purvanas.fr) · [QR Generator](https://qr.purvanas.fr) · [FileDrop](https://drop.purvanas.fr) · [Photo Editor](https://edit.purvanas.fr)
