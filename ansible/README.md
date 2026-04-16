# Ansible

Deploy automation for the **split frontend / backend VM** layout described in **[docs/PROD-SPLIT-NGINX.md](../docs/PROD-SPLIT-NGINX.md)**.

## Quick start

```bash
cd ansible
cp inventory/hosts.ini.example inventory/hosts.ini
cp group_vars/all.yml.example group_vars/all.yml
ansible-playbook -i inventory/hosts.ini --private-key ~/.ssh/id_ed25519 playbooks/site.yml
```

Full variables and run modes: **[docs/ANSIBLE-SETUP.md](../docs/ANSIBLE-SETUP.md)**.
