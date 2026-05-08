# Fix: Systemd Service Path Mismatch

## Problem

**Critical bug discovered:** Ansible builds code in `/home/deploy/CSE356-Discord-Term-Project` but systemd services were pointing to `/root/CSE356-Discord-Term-Project`.

**Impact:** Every deployment built new code but services continued running old code from `/root`. Deployments were completely ineffective.

## Root Cause

Manual systemd service files created on VMs using old documentation (STAGING-ROLLOUT.md) had:
- `User=root`
- `WorkingDirectory=/root/CSE356-Discord-Term-Project` (or `/opt/...`)

But Ansible deploys to:
- `deploy_user: deploy`
- `deploy_path: /home/deploy/CSE356-Discord-Term-Project`

## Solution

### 1. Automated Fix (Recommended)

Set `manage_systemd_services: true` in `ansible/inventory/group_vars/all.yml` (already done in this commit), then run Ansible:

```bash
cd ansible
ansible-playbook -i inventory/hosts.ini playbooks/site.yml
```

This will:
- Deploy correct systemd service files using Jinja2 templates
- Point to `/home/deploy/CSE356-Discord-Term-Project`
- Run services as `deploy` user (not root - more secure!)
- Reload systemd and enable services

### 2. Manual Fix (if needed)

On each VM, update all service files in `/etc/systemd/system/discord-*.service`:

**Before:**
```ini
User=root
WorkingDirectory=/root/CSE356-Discord-Term-Project
```

**After:**
```ini
User=deploy
WorkingDirectory=/home/deploy/CSE356-Discord-Term-Project
```

Then reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart discord-auth discord-communities \
  discord-messages discord-realtime discord-realtime-2 discord-dms discord-read-state
```

### 3. Verify Fix

Check services are running from correct path:
```bash
sudo systemctl status discord-auth | grep WorkingDirectory
# Should show: /home/deploy/CSE356-Discord-Term-Project

ps aux | grep "npm run start"
# Should show deploy user, not root
```

## Files Changed

- `ansible/roles/backend/templates/*.service.j2` - New systemd service templates
- `ansible/roles/search/templates/discord-search.service.j2` - Search service template
- `ansible/roles/backend/tasks/main.yml` - Added systemd deployment task
- `ansible/roles/search/tasks/main.yml` - Added systemd deployment task
- `ansible/inventory/group_vars/all.yml` - Added `manage_systemd_services: true`

## Next Deployment

After merging this fix:
1. Pull latest code on VMs (or let Ansible do it)
2. Run Ansible playbook
3. Services will update to correct paths and restart
4. **Deployments will finally work!**

## Security Improvement

Services now run as `deploy` user instead of `root`:
- ✅ Follows principle of least privilege
- ✅ Limits blast radius if service is compromised
- ✅ Standard practice for production Node.js apps
