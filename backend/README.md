# Backend

FastAPI application entrypoint: `main:app` (local), `app.py` (Vercel autodetection).

Run `python -m pip install -r requirements.txt && uvicorn main:app --reload --port 8000`.

For hosted events, execute `migrations/001_events.sql` in Supabase and configure server-only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

For production console access, set `CONSOLE_ADMIN_TOKEN`. The event endpoint returns 503 on Vercel when the token is missing.

`presets/*.pptx` are **generated example decks**, not original presentation files. Any real `.pptx` can be placed in this folder without code changes, or uploaded through the frontend.
