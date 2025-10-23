# FTP Deploy

A GitHub Action that connects to an FTP server and uploads built files with index.html uploaded last to prevent downtime.

## Example
```yaml
name: Deploy to FTP

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Build project
        run: |
          npm install
          npm run build

      - name: Deploy to FTP
        uses: SculkDev/ftp-deploy@v1
        with:
          ftp-server: ${{ secrets.FTP_SERVER }}
          ftp-username: ${{ secrets.FTP_USERNAME }}
          ftp-password: ${{ secrets.FTP_PASSWORD }}
          ftp-remote-dir: '/public_html'
          build-dir: './dist'
          exclusions: '.htaccess,uploads,.well-known'
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `ftp-server` | FTP server hostname (e.g., `ftp.example.com`) | Yes | - |
| `ftp-username` | FTP username | Yes | - |
| `ftp-password` | FTP password | Yes | - |
| `ftp-remote-dir` | Remote directory path (e.g., `/public_html`) | Yes | - |
| `build-dir` | Local directory with built files | Yes | `./dist` |
| `exclusions` | Comma-separated files/folders to keep | No | `.htaccess,.well-known` |
| `ftp-port` | FTP server port | No | `21` |
| `secure` | Use FTPS (FTP over SSL) | No | `false` |

---
Developed by [edwardcoder](https://edwardcode.net) for [Sculk Software LLC](https://sculk.ltd).