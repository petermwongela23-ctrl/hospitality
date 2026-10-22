from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import re
import sqlite3

APP_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(__file__).resolve().parent / "chw_records.sqlite3"
MAX_BODY_BYTES = 2_000_000
VISIT_TYPES = {"Maternal", "Child", "General"}
URGENCY_LEVELS = {"Routine", "Urgent", "Emergency"}
SYNC_STATUSES = {"Pending", "Syncing", "Synced"}
BP_PATTERN = re.compile(r"^\d{2,3}/\d{2,3}$")


def connect_db():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_db():
    with connect_db() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS visits (
                local_id TEXT PRIMARY KEY,
                chw_id TEXT NOT NULL,
                patient_name TEXT NOT NULL,
                village_name TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                vitals_bp TEXT NOT NULL,
                vitals_temp REAL NOT NULL,
                urgency_level TEXT NOT NULL,
                visit_notes TEXT NOT NULL DEFAULT '',
                created_at_local TEXT NOT NULL,
                sync_status TEXT NOT NULL DEFAULT 'Synced',
                received_at_utc TEXT NOT NULL
            )
        """)


def validate_record(record):
    if not isinstance(record, dict):
        return "Each record must be a JSON object."
    required = ["local_id", "chw_id", "patient_name", "village_name", "visit_type", "vitals_bp", "vitals_temp", "urgency_level", "created_at_local", "sync_status"]
    for field in required:
        if field not in record or record[field] is None or str(record[field]).strip() == "":
            return f"{field} is required."
    for field, limit in [("local_id", 160), ("chw_id", 80), ("patient_name", 160), ("village_name", 120)]:
        if len(str(record[field]).strip()) > limit:
            return f"{field} is too long."
    if len(str(record["patient_name"]).strip()) < 2:
        return "patient_name must have at least 2 characters."
    if record["visit_type"] not in VISIT_TYPES:
        return "visit_type must be Maternal, Child, or General."
    if record["urgency_level"] not in URGENCY_LEVELS:
        return "urgency_level must be Routine, Urgent, or Emergency."
    if not BP_PATTERN.fullmatch(str(record["vitals_bp"]).strip()):
        return "vitals_bp must use SYS/DIA format, for example 120/80."
    try:
        temperature = float(record["vitals_temp"])
        if not 35.0 <= temperature <= 43.0:
            return "vitals_temp must be from 35.0 to 43.0."
    except (TypeError, ValueError):
        return "vitals_temp must be a number."
    try:
        created = datetime.fromisoformat(str(record["created_at_local"]).replace("Z", "+00:00"))
        if created.tzinfo is None or created.utcoffset() != timezone.utc.utcoffset(created):
            return "created_at_local must be an ISO 8601 UTC timestamp."
    except (TypeError, ValueError):
        return "created_at_local must be an ISO 8601 UTC timestamp."
    if record["sync_status"] not in SYNC_STATUSES:
        return "sync_status must be Pending, Syncing, or Synced."
    notes = str(record.get("visit_notes", ""))
    if len(notes) > 1000:
        return "visit_notes must be no longer than 1000 characters."
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print(f"{self.log_date_time_string()} {self.address_string()} {fmt % args}")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            with connect_db() as connection:
                count = connection.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
            return self.send_json(200, {"ok": True, "total_records": count})
        if self.path == "/api/records":
            with connect_db() as connection:
                rows = connection.execute("SELECT * FROM visits ORDER BY received_at_utc DESC LIMIT 250").fetchall()
            return self.send_json(200, {"records": [dict(row) for row in rows]})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/sync":
            return self.send_json(404, {"error": "Route not found."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json(400, {"error": "Invalid Content-Length."})
        if length <= 0 or length > MAX_BODY_BYTES:
            return self.send_json(413, {"error": "Request body is empty or too large."})
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json(400, {"error": "Request must contain valid JSON."})
        records = payload.get("records") if isinstance(payload, dict) else None
        if not isinstance(records, list) or len(records) > 500:
            return self.send_json(400, {"error": "Send a records array containing at most 500 items."})

        results = []
        with connect_db() as connection:
            for record in records:
                error = validate_record(record)
                local_id = record.get("local_id") if isinstance(record, dict) else None
                if error:
                    results.append({"local_id": local_id, "status": "rejected", "error": error})
                    continue
                cursor = connection.execute("""
                    INSERT INTO visits (
                        local_id, chw_id, patient_name, village_name, visit_type,
                        vitals_bp, vitals_temp, urgency_level, visit_notes,
                        created_at_local, sync_status, received_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Synced', ?)
                    ON CONFLICT(local_id) DO NOTHING
                """, (
                    str(record["local_id"]).strip(), str(record["chw_id"]).strip(),
                    str(record["patient_name"]).strip(), str(record["village_name"]).strip(),
                    record["visit_type"], str(record["vitals_bp"]).strip(), float(record["vitals_temp"]),
                    record["urgency_level"], str(record.get("visit_notes", "")).strip(),
                    record["created_at_local"], datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                ))
                results.append({"local_id": local_id, "status": "synced" if cursor.rowcount == 1 else "duplicate"})
        accepted = sum(item["status"] in {"synced", "duplicate"} for item in results)
        self.send_json(200, {"received": len(records), "accepted": accepted, "results": results})


if __name__ == "__main__":
    initialize_db()
    server = ThreadingHTTPServer(("0.0.0.0", 8000), Handler)
    print("Afya Field Notes is ready at http://localhost:8000")
    print("Press Ctrl+C to stop the server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()
