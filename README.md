# The 48 Index update scheduler

A small, deterministic GitHub Actions scheduler for [48index.com](https://48index.com).

Every 15 minutes it calls the protected completed-game importer. The application decides whether a match window is active. Dormant invocations do not contact basketball providers. Active checks fetch only missing or incomplete final games, and stop frequent polling once the slate is complete. The website's independent daily safety check handles delayed corrections.

This repository contains no site source, basketball data, subscriber records, owner session or production-host credentials. The `FINAL_SYNC_KEY` repository secret authorizes only `POST https://48index.com/api/sync/finals`. Jobs use standard GitHub-hosted runners, no checkout, no dependencies, no artifacts and no AI model. They cannot SSH to a server or deploy the website.

The manual Run workflow control exercises the same path. Logs contain only operational counts and the next useful check time, never the key or response bodies with user data. Concurrent runs are serialized, with a second owner-checked lease in the application.

GitHub schedules are best effort and may be delayed. Scheduled workflows in public repositories may be disabled after 60 days without repository activity. The existing site safety jobs remain enabled independently; inspect Actions if the 15-minute cadence stops.
