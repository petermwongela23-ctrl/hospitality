# Afya Field Notes

An offline-first CHW visit-record prototype for the hackathon. It uses a plain JavaScript PWA, IndexedDB in the browser, Python's standard-library HTTP server, and SQLite.

## Run on the computer

From this folder, run:

```powershell
python backend/server.py
```

Open `http://localhost:8000` in Chrome or Edge. Keep the server window open while using the app.

## Open it on an Android phone

After the app has loaded once online, it can continue opening and saving locally while the backend server is stopped or unreachable. Those visits stay pending on the phone until the backend and tunnel are running again. The `ONLINE` badge reflects the phone's network connection; the server message in the queue area shows whether the API is reachable. Use fictional data only.

The PWA and its service worker need HTTPS on the phone. Keep the Python server running in the first VS Code terminal, then open a second terminal at this project folder and run:

```powershell
npx --yes localtunnel --port 8000
```

If npm asks to install `localtunnel`, type `y`. Copy the HTTPS URL printed by the command and open it in Chrome on the Android phone. The tunnel is public while it runs and has no app login, so use fictional demo records only. Keep the server and tunnel running for the whole demonstration. Stop each with **Ctrl+C** afterward.

On Android Chrome, open the HTTPS app link, allow the app to finish loading while online, then use the browser menu and choose **Install app** or **Add to Home screen**. Launch it from the home-screen icon once while connected before demonstrating offline mode.

## API

- `GET /api/health` reports server availability and saved record count.
- `GET /api/records` lists up to 250 records stored in SQLite.
- `POST /api/sync` accepts `{ "records": [...] }`; `local_id` is a primary key so repeated uploads are idempotent.

The database file is `backend/chw_records.sqlite3` and is created on first run.

## Demo checklist

1. Save a record while online and confirm the pending count returns to zero.
2. Load the app, then disconnect the phone from the network.
3. Save two fictional records and confirm the offline indicator and pending count.
4. Close and reopen or refresh the installed app while still offline; confirm the two records remain.
5. Reconnect, select **Sync queue**, and confirm the pending count returns to zero.
6. Send one of the same records again; the API responds `duplicate` and does not insert a second database row.

This prototype has no login, encryption-at-rest, role permissions, or production privacy controls. It is for a fictional-data demo only.
