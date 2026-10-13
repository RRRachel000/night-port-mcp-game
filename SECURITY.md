# Security and deployment boundaries

Night Port is self-hosted software, not a public hosted service. Deployers control their own account, data, access and costs. There is no support SLA or promised response time.

- Cloud instances are private by default. Admin, viewer and seat credentials have distinct capabilities.
- A seat key controls one game seat. Keep it out of prompts, screenshots, public issues and repositories. Never give an operator key or an all-seat recovery file to a player.
- OAuth grants are tied to the current seat key. Takeover invalidates prior access. Exported snapshots contain credentials and private achievements.
- Keep `.local/`, saved games, environment files and Wrangler state private. Review both files and Git history before publishing a fork.
- Local HTTP binds to loopback by default and has no internet-facing authentication. Use the cloud gateway for remote access.
- Do not operate two writers for one game. Stop the old authority, import and verify, then switch clients.
- Do not expose tokens in public bug reports. Use GitHub private vulnerability reporting if offered; otherwise provide only a redacted description. No private channel or response schedule is promised.

The MIT license and individual dependency licenses govern the software. Deployers evaluate their own environment and provider requirements.
