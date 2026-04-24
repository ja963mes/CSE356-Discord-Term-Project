# Ansible

Deploy automation for the **split frontend / backend / auth / realtime / search VM** layout described in **[docs/PROD-SPLIT-NGINX.md](../docs/PROD-SPLIT-NGINX.md)**.

It can also optionally deploy **Zabbix agent 2** to all managed VMs when `manage_zabbix_agent: true` and `zabbix_agent_server` are set in inventory vars.

## Quick start

```bash
cd ansible
cp inventory/hosts.ini.example inventory/hosts.ini
# group_vars/all.yml is in git with defaults; copy from .example only if you override locally
ansible-playbook -i inventory/hosts.ini --private-key ~/.ssh/id_ed25519 playbooks/site.yml
```

Full variables and run modes: **[docs/ANSIBLE-SETUP.md](../docs/ANSIBLE-SETUP.md)**.
