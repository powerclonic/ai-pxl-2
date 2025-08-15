# Pixel Canvas 2.0

## Environment Variables
- DATABASE_URL (default sqlite+aiosqlite:///./data/app.db)
- REDIS_URL (redis://localhost:6379/0)
- ENABLE_REDIS (true|false)
- DB_POOL_SIZE / DB_POOL_MAX_OVERFLOW
- METRICS_FLUSH_INTERVAL_MS (default 3000)
- CANVAS_SNAPSHOT_INTERVAL_SEC (default 300)
- CANVAS_SNAPSHOT_RETENTION (reserved for future multi-file snapshots)
- DEFAULT_ADMIN_USERNAME / DEFAULT_ADMIN_PASSWORD
- PIXEL_REFILL_RATE, MAX_PIXEL_BAG, INITIAL_PIXEL_BAG

## Deployment (Coolify + Nixpacks)
Nixpacks detects Python. Ensure `requirements.txt` includes dependencies (FastAPI, uvicorn, SQLAlchemy, aiosqlite, redis, pandas, pyarrow, jwt, etc.). Set environment variables in Coolify UI. Expose port 8000. Start command:

```
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

SQLite is fine for dev; use PostgreSQL in production (e.g. `postgresql+asyncpg://user:pass@host/db`).

## Legacy Notice
`persistence_service` retained only for initial JSON bootstrap/backups. All active writes go to database/Redis + parquet canvas.

## Achievements
Definitions stored in DB (auto-seeded from `data/achievements.json` if empty). Admin CRUD via UI calls `/api/achievements/admin/*`.

## Rankings
Queried from DB each request. Redis counters accumulate high-frequency increments (pixels/messages) and flush asynchronously.

## Canvas Persistence
Parquet snapshot plus incremental batches. Periodic snapshot interval configurable. Retention hook ready for multi-file rotation.

## Sessions
Currently persisted in JSON (migration candidate to Redis hash). Replaceable by storing session_tokens in Redis with TTL.

## Roadmap (Optional Future)
- Move sessions -> Redis
- Multi-file snapshot rotation
- Metrics endpoint for counter flush status

