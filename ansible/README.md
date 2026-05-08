# Ansible

Deploy automation for the **split frontend / backend / auth / realtime / search VM** layout described in **[docs/PROD-SPLIT-NGINX.md](../docs/PROD-SPLIT-NGINX.md)**.

## Quick start

```bash
cd ansible
cp inventory/hosts.ini.example inventory/hosts.ini
# group_vars/all/main.yml is in git with defaults; copy from .example only if you override locally
ansible-playbook -i inventory/hosts.ini --private-key ~/.ssh/id_ed25519 playbooks/site.yml
```

For local-only overrides that should never be committed, create
`inventory/group_vars/all/local.yml`. Ansible will merge files from that
directory automatically, and `.gitignore` excludes the file from version control.

Full variables and run modes: **[docs/ANSIBLE-SETUP.md](../docs/ANSIBLE-SETUP.md)**.

## Zabbix bootstrap

After the agent rollout is complete, you can create/update Zabbix hosts and
Discord-specific items from the repo root with:

```bash
ZABBIX_URL=http://130.245.136.166/api_jsonrpc.php \
ZABBIX_TOKEN=your_api_token_here \
ZABBIX_BACKEND_IP=your_backend_private_ip \
npm run zabbix:bootstrap
```

Notes:

- `ZABBIX_TOKEN` should be a Zabbix API token created in the web UI.
- `ZABBIX_BACKEND_IP` is only needed because `backend-vm` uses
  `ansible_host=127.0.0.1` in inventory for local Ansible execution.
- The bootstrap script creates a `Discord` host group by default and links the
  `Linux by Zabbix agent` template when it exists.
