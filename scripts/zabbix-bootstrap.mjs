import { readFile } from "node:fs/promises";

const ZABBIX_URL = process.env.ZABBIX_URL;
const ZABBIX_TOKEN = process.env.ZABBIX_TOKEN;
const ZABBIX_HOST_GROUP = process.env.ZABBIX_HOST_GROUP || "Discord";
const ZABBIX_TEMPLATE = process.env.ZABBIX_TEMPLATE || "Linux by Zabbix agent";
const ZABBIX_BACKEND_IP = process.env.ZABBIX_BACKEND_IP || "";
const INVENTORY_PATH =
  process.env.ZABBIX_INVENTORY_PATH || "ansible/inventory/hosts.ini";

if (!ZABBIX_URL || !ZABBIX_TOKEN) {
  console.error(
    "Set ZABBIX_URL and ZABBIX_TOKEN before running this script.",
  );
  process.exit(1);
}

const rpc = async (method, params) => {
  const res = await fetch(ZABBIX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json-rpc",
      Authorization: `Bearer ${ZABBIX_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: Date.now(),
    }),
  });

  if (!res.ok) {
    throw new Error(`${method} HTTP ${res.status}`);
  }

  const payload = await res.json();
  if (payload.error) {
    throw new Error(`${method} API error: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
};

const parseInventory = async () => {
  const text = await readFile(INVENTORY_PATH, "utf8");
  const hosts = new Map();
  let currentGroup = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const groupMatch = line.match(/^\[(.+)\]$/);
    if (groupMatch) {
      currentGroup = groupMatch[1];
      continue;
    }

    if (!currentGroup || currentGroup.includes(":")) continue;

    const parts = line.split(/\s+/);
    const name = parts[0];
    const attrs = Object.fromEntries(
      parts.slice(1).map((part) => {
        const [k, ...rest] = part.split("=");
        return [k, rest.join("=")];
      }),
    );

    if (!hosts.has(name)) {
      hosts.set(name, {
        name,
        ansibleHost: attrs.ansible_host || "",
        groups: new Set(),
      });
    }

    const host = hosts.get(name);
    if (attrs.ansible_host) host.ansibleHost = attrs.ansible_host;
    host.groups.add(currentGroup);
  }

  return [...hosts.values()].map((host) => ({
    ...host,
    groups: [...host.groups],
  }));
};

const serviceItem = (service) => ({
  name: `${service} active`,
  key: `discord.service.active[${service}]`,
});

const healthItem = (label, url) => ({
  name: `${label} health`,
  key: `discord.health[${url}]`,
});

const baseItems = [{ name: "Agent ping", key: "agent.ping" }];

const planForHost = (host) => {
  const { name, groups } = host;
  let ip = host.ansibleHost;
  if (name === "backend-vm" && ip === "127.0.0.1") {
    ip = ZABBIX_BACKEND_IP;
  }
  if (!ip || ip === "127.0.0.1") {
    return null;
  }

  const items = [...baseItems];

  if (groups.includes("auth")) {
    items.push(
      serviceItem("discord-auth"),
      healthItem("Auth", "http://127.0.0.1:3001/health"),
    );
  }

  if (groups.includes("messages")) {
    items.push(
      serviceItem("discord-messages"),
      healthItem("Messages", "http://127.0.0.1:3003/health"),
    );
  }

  if (groups.includes("search")) {
    items.push(
      serviceItem("discord-search"),
      healthItem("Search", "http://127.0.0.1:3004/health"),
    );
  }

  if (groups.includes("dms")) {
    items.push(
      serviceItem("discord-dms"),
      healthItem("DMs", "http://127.0.0.1:3007/health"),
    );
  }

  if (groups.includes("read_state")) {
    items.push(
      serviceItem("discord-read-state"),
      healthItem("Read-state", "http://127.0.0.1:3008/health"),
    );
  }

  if (groups.includes("communities")) {
    items.push(
      serviceItem("discord-communities"),
      serviceItem("discord-create-community"),
      healthItem("Communities", "http://127.0.0.1:3002/health"),
      healthItem("Create-community", "http://127.0.0.1:3006/health"),
    );
  }

  if (groups.includes("realtime")) {
    items.push(
      serviceItem("discord-realtime"),
      serviceItem("discord-realtime-2"),
      serviceItem("discord-realtime-3"),
      serviceItem("discord-realtime-4"),
      healthItem("Realtime 3005", "http://127.0.0.1:3005/health"),
      healthItem("Realtime 3009", "http://127.0.0.1:3009/health"),
      healthItem("Realtime 3013", "http://127.0.0.1:3013/health"),
      healthItem("Realtime 3017", "http://127.0.0.1:3017/health"),
    );
  }

  if (groups.includes("frontend")) {
    items.push(
      serviceItem("nginx"),
      healthItem("Frontend", "http://127.0.0.1/healthz"),
    );
  }

  if (groups.includes("redis")) {
    items.push(serviceItem("redis-pubsub"), serviceItem("redis-kv"));
  }

  return {
    host: name,
    ip,
    groups,
    items,
  };
};

const getOrCreateGroup = async (name) => {
  const found = await rpc("hostgroup.get", {
    output: ["groupid", "name"],
    filter: { name: [name] },
  });
  if (found.length) return found[0].groupid;
  const created = await rpc("hostgroup.create", { name });
  return created.groupids[0];
};

const getTemplateId = async (name) => {
  const found = await rpc("template.get", {
    output: ["templateid", "host"],
    filter: { host: [name] },
  });
  return found[0]?.templateid || null;
};

const getOrCreateHost = async (plan, groupid, templateid) => {
  const found = await rpc("host.get", {
    output: ["hostid", "host", "name"],
    selectInterfaces: ["interfaceid", "ip", "port", "main", "type", "useip"],
    filter: { host: [plan.host] },
  });

  if (!found.length) {
    const created = await rpc("host.create", {
      host: plan.host,
      name: plan.host,
      groups: [{ groupid }],
      templates: templateid ? [{ templateid }] : [],
      tags: [{ tag: "managed-by", value: "scripts/zabbix-bootstrap.mjs" }],
      interfaces: [
        {
          type: 1,
          main: 1,
          useip: 1,
          ip: plan.ip,
          dns: "",
          port: "10050",
        },
      ],
    });
    return {
      hostid: created.hostids[0],
      interfaceid: null,
      created: true,
    };
  }

  const host = found[0];
  const agentInterface =
    host.interfaces.find((iface) => Number(iface.type) === 1) || host.interfaces[0];

  if (agentInterface) {
    await rpc("hostinterface.update", {
      interfaceid: agentInterface.interfaceid,
      type: 1,
      main: 1,
      useip: 1,
      ip: plan.ip,
      dns: "",
      port: "10050",
    });
  }

  return {
    hostid: host.hostid,
    interfaceid: agentInterface?.interfaceid || null,
    created: false,
  };
};

const upsertItem = async ({ hostid, interfaceid, item }) => {
  const existing = await rpc("item.get", {
    output: ["itemid", "name", "key_", "interfaceid"],
    hostids: hostid,
    filter: { key_: [item.key] },
  });

  const payload = {
    name: item.name,
    key_: item.key,
    type: 0,
    value_type: 3,
    delay: "30s",
    status: 0,
  };

  if (item.key !== "agent.ping") {
    payload.interfaceid = interfaceid;
  }

  if (existing.length) {
    await rpc("item.update", {
      itemid: existing[0].itemid,
      ...payload,
    });
    return "updated";
  }

  await rpc("item.create", {
    hostid,
    ...payload,
  });
  return "created";
};

const main = async () => {
  const inventoryHosts = await parseInventory();
  const plans = inventoryHosts
    .map(planForHost)
    .filter(Boolean);

  if (!plans.length) {
    throw new Error("No Zabbix host plans could be built from inventory.");
  }

  const groupid = await getOrCreateGroup(ZABBIX_HOST_GROUP);
  const templateid = await getTemplateId(ZABBIX_TEMPLATE);
  if (!templateid) {
    console.warn(
      `Template "${ZABBIX_TEMPLATE}" not found. Hosts will be created without it.`,
    );
  }

  for (const plan of plans) {
    console.log(`\n==> ${plan.host} (${plan.ip})`);
    const { hostid, interfaceid, created } = await getOrCreateHost(
      plan,
      groupid,
      templateid,
    );
    console.log(created ? `created host ${hostid}` : `using host ${hostid}`);

    const hostData = await rpc("host.get", {
      output: ["hostid"],
      selectInterfaces: ["interfaceid", "type", "main"],
      hostids: [hostid],
    });
    const agentInterface =
      hostData[0].interfaces.find((iface) => Number(iface.type) === 1) ||
      hostData[0].interfaces[0];

    for (const item of plan.items) {
      const result = await upsertItem({
        hostid,
        interfaceid: interfaceid || agentInterface?.interfaceid,
        item,
      });
      console.log(`  ${result}: ${item.key}`);
    }
  }

  console.log("\nDone.");
};

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
