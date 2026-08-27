# OSI

Check whether one or more URLs return OK or are reachable.

**Stack:** Python (FastAPI) + Next.js · no database

## Setup

### Backend

```bash
cd backend
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

API: `http://127.0.0.1:8001` · docs: `http://127.0.0.1:8001/docs`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

App: `http://localhost:3000`

Set `NEXT_PUBLIC_API_URL` in `frontend/.env.local` if the API is not on `http://127.0.0.1:8001`.

## Usage

1. Start the backend, then the frontend.
2. Paste URLs (one per line or comma-separated).
3. Click **Check URLs**.

Results:

- **OK** — HTTP 2xx / 3xx
- **Reachable** — server responded but not OK (e.g. 4xx)
- **Unreachable** — timeout, DNS, connection error, or 5xx
