#!/usr/bin/env python3
"""원본 일정·장소 데이터(JSONL)를 Firestore로 옮기는 한 번용 도구.

보기용 계정(viewer@example.com)으로 로그인해 Firestore REST API로 씁니다.
비밀번호는 VIEW_PIN 환경변수로만 받습니다.

  VIEW_PIN=… python3 tools/migrate.py --raw <폴더> [--replace] [--dry-run]
  (로컬 테스트) … --emulator 127.0.0.1:8080,127.0.0.1:9099

<폴더>에는 sessions.jsonl / places.jsonl / meta.jsonl 이 있고,
한 줄에 {"id", "data", "version", "updatedAt"} 형식의 문서가 하나씩 들어 있어야 합니다.
"""
import argparse
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
COLLECTIONS = ["sessions", "places", "meta"]


def read_config():
    text = (ROOT / "firebase-config.js").read_text(encoding="utf-8")
    api = re.search(r'apiKey:\s*["\']([^"\']+)', text)
    pid = re.search(r'projectId:\s*["\']([^"\']+)', text)
    email = re.search(r"VIEWER_EMAIL\s*=\s*'([^']+)'", text)
    prefix = re.search(r"viewerPassword\s*=\s*pin\s*=>\s*`([^$`]*)\$\{pin\}([^`]*)`", text)
    if not (api and pid and email and prefix):
        sys.exit("firebase-config.js에서 apiKey/projectId/VIEWER_EMAIL/viewerPassword를 찾지 못했습니다.")
    return api.group(1), pid.group(1), email.group(1), (prefix.group(1), prefix.group(2))


def call(url, body=None, token=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"요청 실패 {e.code}: {e.read().decode(errors='replace')[:600]}")


def value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [value(x) for x in v]} if v else {}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: value(x) for k, x in v.items()}}}
    raise TypeError(f"지원하지 않는 값: {v!r}")


def read_jsonl(path):
    if not path.exists():
        return []
    docs = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            d = json.loads(line)
            if not d.get("id") or not isinstance(d.get("data"), dict):
                sys.exit(f"{path}:{i} 형식 오류 (id, data 필요)")
            docs.append(d)
    return docs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--emulator", help="firestoreHost:port,authHost:port")
    ap.add_argument("--replace", action="store_true", help="이미 데이터가 있어도 덮어쓰기")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    pin = os.environ.get("VIEW_PIN")
    if not pin:
        sys.exit("VIEW_PIN 환경변수에 보기 비밀번호를 넣어주세요.")
    api_key, pid, email, (pre, post) = read_config()

    if a.emulator:
        fs_host, auth_host = a.emulator.split(",")
        auth_base = f"http://{auth_host}/identitytoolkit.googleapis.com"
        fs_root = f"http://{fs_host}/v1"
    else:
        auth_base = "https://identitytoolkit.googleapis.com"
        fs_root = "https://firestore.googleapis.com/v1"
    db_path = f"projects/{pid}/databases/(default)/documents"

    raw = pathlib.Path(a.raw)
    docs = {c: read_jsonl(raw / f"{c}.jsonl") for c in COLLECTIONS}
    for c in COLLECTIONS:
        print(f"{c}: {len(docs[c])}건 준비")
    if not docs["sessions"]:
        sys.exit("sessions.jsonl이 비어 있습니다.")

    login = call(f"{auth_base}/v1/accounts:signInWithPassword?key={api_key}",
                 {"email": email, "password": f"{pre}{pin}{post}", "returnSecureToken": True})
    token = login["idToken"]
    print(f"로그인: {email}")

    existing = sum(len(call(f"{fs_root}/{db_path}/{c}?pageSize=300", token=token).get("documents", [])) for c in COLLECTIONS)
    if existing and not a.replace:
        sys.exit(f"Firestore에 이미 문서 {existing}건이 있습니다. 덮어쓰려면 --replace를 붙이세요.")

    writes = []
    for c in COLLECTIONS:
        for d in docs[c]:
            data = {k: v for k, v in d["data"].items() if k != "id"}
            fields = {k: value(v) for k, v in data.items()}
            if d.get("updatedAt"):
                fields["updatedAt"] = {"timestampValue": d["updatedAt"]}
            writes.append({"update": {"name": f"{db_path}/{c}/{d['id']}", "fields": fields}})

    if a.dry_run:
        print(f"(dry-run) {len(writes)}건을 쓸 예정입니다.")
        return
    for i in range(0, len(writes), 200):
        call(f"{fs_root}/{db_path}:commit", {"writes": writes[i:i + 200]}, token=token)
    counts = {c: len(call(f"{fs_root}/{db_path}/{c}?pageSize=300", token=token).get("documents", [])) for c in COLLECTIONS}
    print(f"완료: {len(writes)}건 저장 → 현재 Firestore {counts}")


if __name__ == "__main__":
    main()
