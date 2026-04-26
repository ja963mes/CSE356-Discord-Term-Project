# Ansible

Deploy automation for the **split frontend / backend / auth / realtime / search VM** layout described in **[docs/PROD-SPLIT-NGINX.md](../docs/PROD-SPLIT-NGINX.md)**.

## Quick start

```bash
cd ansible
cp inventory/hosts.ini.example inventory/hosts.ini
# group_vars/all.yml is in git with defaults; copy from .example only if you override locally
ansible-playbook -i inventory/hosts.ini --private-key ~/.ssh/id_ed25519 playbooks/site.yml
```

For local-only overrides that should never be committed, create
`inventory/group_vars/all/local.yml`. Ansible will merge files from that
directory automatically, and `.gitignore` excludes the file from version control.

Full variables and run modes: **[docs/ANSIBLE-SETUP.md](../docs/ANSIBLE-SETUP.md)**.
