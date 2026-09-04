import Docker from "dockerode";
import fs from "fs-extra";
import path from "path";
let ioInstance: any = null;
export const setDockerIO = (io: any) => { ioInstance = io; };
import { readJSON } from "./db.js";

const getSocketPath = () => {
  if (process.platform === 'win32') return '//./pipe/docker_engine';
  if (process.env.DOCKER_SOCKET_PATH && fs.existsSync(process.env.DOCKER_SOCKET_PATH)) {
    return process.env.DOCKER_SOCKET_PATH;
  }
  if (fs.existsSync('/var/run/docker.sock')) return '/var/run/docker.sock';
  if (fs.existsSync('/run/docker.sock')) return '/run/docker.sock';
  return '/var/run/docker.sock';
};

export const isSandbox = !fs.existsSync('/var/run/docker.sock') &&
  !fs.existsSync('/run/docker.sock') &&
  !(process.env.DOCKER_SOCKET_PATH && fs.existsSync(process.env.DOCKER_SOCKET_PATH)) &&
  process.platform !== 'win32';

export const defaultDocker = new Docker({ socketPath: getSocketPath() });

export const getDocker = async (nodeId?: string) => {
  if (!nodeId || nodeId === "local") return defaultDocker;
  const nodes = await readJSON("nodes.json") || [];
  const node = nodes.find((n: any) => n.id === nodeId);
  if (node) {
    let host = node.ip;
    let protocol: "http" | "https" | "ssh" = "http";
    let port = node.port;

    if (!host.startsWith("http://") && !host.startsWith("https://")) {
      if (port === 443) protocol = "https";
    } else {
      try {
        const url = new URL(host);
        protocol = (url.protocol.replace(':', '') === 'https' ? 'https' : 'http');
        host = url.hostname;
        if (url.port) port = parseInt(url.port);
        else port = protocol === "https" ? 443 : 80;
      } catch (e) {
        console.error("Invalid URL in node IP", host);
      }
    }
    return new Docker({
      protocol,
      host,
      port,
      headers: { 
        Authorization: "Bearer " + node.key,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JTGPanel/1.0"
      }
    });
  }
  return defaultDocker;
};

// Mock state for sandbox demo
export const mockState: Record<string, boolean> = {};
export const mockStartTime: Record<string, string | null> = {};

export const getVersions = async (type: string = "PAPER") => {
  const normalizedType = type.toUpperCase();
  if (normalizedType === "POCKETMINE_MP" || normalizedType === "POCKETMINE") {
    return ["latest", "5.22.0", "5.21.0", "5.20.0", "5.10.0", "4.0.0"];
  }
  if (normalizedType === "VELOCITY") {
    return ["latest", "3.3.0-SNAPSHOT"];
  }
  if (normalizedType === "BUNGEECORD" || normalizedType === "WATERFALL") {
    return ["latest"];
  }
  
  return [
    "latest", "1.21.1", "1.21.0", "1.20.6", "1.20.4", "1.20.1", "1.19.4", 
    "1.19.2", "1.18.2", "1.17.1", "1.16.5", "1.12.2", "1.8.8"
  ];
};

export const createServerContainer = async (serverData: any, nodeId?: string) => {
  const docker = await getDocker(nodeId || serverData.nodeId);
  if (isSandbox) {
    mockState[serverData.id] = false;
    return "mock-container-id-" + serverData.id;
  }

  const serverType = (serverData.type || "PAPER").toUpperCase();
  const isPocketMine = serverType === "POCKETMINE_MP" || serverType === "POCKETMINE";
  const isProxy = ["VELOCITY", "BUNGEECORD", "WATERFALL"].includes(serverType);

  let shortImage = "itzg/minecraft-server:latest";
  let fullImage = "docker.io/itzg/minecraft-server:latest";

  if (isPocketMine) {
    shortImage = "pmmp/pocketmine-mp:latest";
    fullImage = "docker.io/pmmp/pocketmine-mp:latest";
  } else if (isProxy) {
    shortImage = "itzg/bungeecord:latest";
    fullImage = "docker.io/itzg/bungeecord:latest";
  }

  const findImageId = async (): Promise<string | null> => {
    try {
      const images = await docker.listImages();
      const matched = images.find(img => 
        img.RepoTags && img.RepoTags.some(tag => tag.includes(shortImage) || tag.includes(fullImage))
      );
      if (matched) return matched.Id;
    } catch(e) {
      console.warn("Failed to list images:", e);
    }
    return null;
  };

  const pullImageStream = async (imgTag: string) => {
    console.log(`Pulling image ${imgTag}...`);
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execAsync = promisify(exec);
    
    try {
      const { stdout, stderr } = await execAsync(`docker pull ${imgTag}`);
      if (stderr) console.warn(`docker pull stderr:`, stderr);
    } catch (cliErr) {
      await new Promise((resolve, reject) => {
        docker.pull(imgTag, (err: any, stream: any) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err: any, output: any) => {
            if (err) return reject(err);
            resolve(output);
          });
        });
      });
    }
  };

  const ensureImage = async (): Promise<string> => {
    let existingId = await findImageId();
    if (existingId) return existingId;

    try {
      await pullImageStream(shortImage);
      let idAfterShort = await findImageId();
      if (idAfterShort) return idAfterShort;
    } catch (e) {
      console.warn(`Failed to pull ${shortImage}...`, e);
    }

    await pullImageStream(fullImage);
    let idAfterFull = await findImageId();
    if (idAfterFull) return idAfterFull;

    return shortImage;
  };

  const targetImage = await ensureImage();
  const serverDir = path.join(process.cwd(), ".data", "servers", serverData.id);
  await fs.ensureDir(serverDir);

  const envVars = [
    `MEMORY=${serverData.ram}G`,
    `SERVER_PORT=${serverData.port}`,
  ];

  if (isPocketMine) {
    envVars.push(`PUBLIC_PORT=${serverData.port}`);
  } else if (isProxy) {
    envVars.push(`TYPE=${serverType}`, `VERSION=${serverData.version}`);
  } else {
    envVars.push(
      `TYPE=${serverType}`,
      `VERSION=${serverData.version}`,
      `INIT_MEMORY=128M`,
      `EULA=TRUE`,
      `ENABLE_RCON=true`,
      `RCON_PASSWORD=admin`
    );
  }

  // Network bindings configuration
  const portStr = `${serverData.port}`;
  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};

  if (isPocketMine) {
    // Bedrock (PocketMine-MP) uses UDP primarily, mapping both TCP & UDP for safety
    exposedPorts[`${portStr}/udp`] = {};
    exposedPorts[`${portStr}/tcp`] = {};
    portBindings[`${portStr}/udp`] = [{ HostPort: portStr }];
    portBindings[`${portStr}/tcp`] = [{ HostPort: portStr }];
  } else {
    exposedPorts[`${portStr}/tcp`] = {};
    portBindings[`${portStr}/tcp`] = [{ HostPort: portStr }];
  }

  const buildContainerOptions = (img: string) => ({
    Image: img,
    name: `jtg-server-${serverData.id}`,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    Env: envVars,
    ExposedPorts: exposedPorts,
    HostConfig: {
      PortBindings: portBindings,
      Binds: [`${serverDir}:${isPocketMine || isProxy ? '/server' : '/data'}`]
    }
  });

  let container;
  try {
    container = await docker.createContainer(buildContainerOptions(targetImage));
  } catch (err: any) {
    const altImage = targetImage === shortImage ? fullImage : shortImage;
    await pullImageStream(altImage);
    container = await docker.createContainer(buildContainerOptions(altImage));
  }

  return container.id;
};
export const startContainer = async (containerId: string, nodeId?: string) => {
  const docker = await getDocker(nodeId);
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    mockState[id] = true;
    mockStartTime[id] = new Date().toISOString();
    
    try {
      const servers = await readJSON("servers.json") || [];
      const server = servers.find((s: any) => s.id === id);
      if (server) {
        const serverDir = path.join(process.cwd(), ".data", "servers", id);
        await fs.ensureDir(serverDir);
        const type = (server.type || "PAPER").toUpperCase();
        
        if (type === "POCKETMINE_MP" || type === "POCKETMINE") {
          const configPath = path.join(serverDir, "server.properties");
          if (!fs.existsSync(configPath)) {
            await fs.writeFile(configPath, `server-name=PocketMine-MP Server\nserver-port=${server.port}\ngamemode=survival\n`);
          }
        } else if (["VELOCITY", "BUNGEECORD", "WATERFALL"].includes(type)) {
          const configName = type === "VELOCITY" ? "velocity.toml" : "config.yml";
          const configPath = path.join(serverDir, configName);
          if (!fs.existsSync(configPath)) {
            await fs.writeFile(configPath, `# Autogenerated proxy config in sandbox mode\nport: ${server.port}\n`);
          }
        } else {
          const propsPath = path.join(serverDir, "server.properties");
          if (!fs.existsSync(propsPath)) {
            await fs.writeFile(propsPath, `server-port=${server.port}\nmotd=A Minecraft Server\n`);
          }
        }
      }
    } catch(e) {}
    
    ioInstance?.to(`server_${id}`).emit("log", `[System] Server started (Sandbox Mode).\r\n`);
    return;
  }
  const container = docker.getContainer(containerId);
  await container.start();
};

export const stopContainer = async (containerId: string, nodeId?: string) => {
  const docker = await getDocker(nodeId);
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    mockState[id] = false;
    mockStartTime[id] = null;
    ioInstance?.to(`server_${id}`).emit("log", `[System] Server stopped (Sandbox Mode).\r\n`);
    return;
  }
  const container = docker.getContainer(containerId);
  await container.stop();
};

export const restartContainer = async (containerId: string, nodeId?: string) => {
  const docker = await getDocker(nodeId);
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    mockState[id] = true;
    mockStartTime[id] = new Date().toISOString();
    ioInstance?.to(`server_${id}`).emit("log", `[System] Server restarted (Sandbox Mode).\r\n`);
    return;
  }
  const container = docker.getContainer(containerId);
  await container.restart();
};

export const deleteContainer = async (containerId: string, nodeId?: string) => {
  const docker = await getDocker(nodeId);
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    delete mockState[id];
    delete mockStartTime[id];
    return;
  }
  const container = docker.getContainer(containerId);
  try {
    const info = await container.inspect();
    if (info.State.Running) {
      await container.stop();
    }
    await container.remove({ force: true });
  } catch (err) {
    console.error("Error deleting container", err);
  }
};

export const getContainerStatus = async (containerId: string, nodeId?: string) => {
  const docker = await getDocker(nodeId);
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    const isRunning = mockState[id] || false;
    return { State: { Running: isRunning, Status: isRunning ? "running" : "exited" } };
  }
  try {
    const container = docker.getContainer(containerId);
    return await container.inspect();
  } catch (e) {
    return null;
  }
};

let diskCache: Record<string, { sizeMB: number, lastUpdate: number }> = {};
async function getDirectorySize(dir: string): Promise<number> {
  let size = 0;
  try {
    const files = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      const p = path.join(dir, file.name);
      if (file.isDirectory()) {
        size += await getDirectorySize(p);
      } else {
        const stat = await fs.promises.stat(p);
        size += stat.size;
      }
    }
  } catch (e) {}
  return size;
}

export const getContainerStats = async (containerId: string, nodeId?: string, serverId?: string) => {
  const docker = await getDocker(nodeId);
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    if (!mockState[id]) return { cpu: 0, ram: 0, disk: 0, netIn: 0, netOut: 0, startedAt: null };
    
    const timeSec = Math.floor(Date.now() / 5000);
    const floatPseudo = (Math.sin(timeSec + id.charCodeAt(0)) + 1) / 2;
    
    return {
      cpu: floatPseudo * 10 + 2,
      ram: 450 + (floatPseudo * 50 - 25),
      disk: 1.5,
      netIn: timeSec * 1024,
      netOut: timeSec * 512,
      startedAt: mockStartTime[id] || new Date().toISOString()
    };
  }
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    if (!info.State.Running) {
      return { cpu: 0, ram: 0, disk: 0, netIn: 0, netOut: 0, startedAt: null };
    }
    const statsResult = await container.stats({ stream: false });
    
    let cpuPercent = 0.0;
    try {
      const cpuDelta = statsResult.cpu_stats.cpu_usage.total_usage - statsResult.precpu_stats.cpu_usage.total_usage;
      const systemDelta = statsResult.cpu_stats.system_cpu_usage - statsResult.precpu_stats.system_cpu_usage;
      if (systemDelta > 0.0 && cpuDelta > 0.0) {
        const cpus = statsResult.cpu_stats.online_cpus || statsResult.cpu_stats.cpu_usage.percpu_usage?.length || 1;
        cpuPercent = (cpuDelta / systemDelta) * cpus * 100.0;
      }
    } catch(e) {}

    let ramMB = 0.0;
    try {
      const stats = statsResult.memory_stats.stats as any || {};
      const cache = stats.cache || stats.inactive_file || stats.total_inactive_file || 0;
      const usedMemory = statsResult.memory_stats.usage - cache;
      ramMB = usedMemory / 1024 / 1024;
    } catch(e) {}
    
    let netIn = 0;
    let netOut = 0;
    try {
      const networks = statsResult.networks || {};
      for (const net of Object.values<any>(networks)) {
        netIn += net.rx_bytes;
        netOut += net.tx_bytes;
      }
    } catch(e) {}

    let diskSizeMB = 1.5;
    if (serverId) {
       const now = Date.now();
       if (!diskCache[serverId] || now - diskCache[serverId].lastUpdate > 60000) {
          const dir = path.join(process.cwd(), ".data", "servers", serverId);
          const bytes = await getDirectorySize(dir);
          diskCache[serverId] = { sizeMB: bytes / 1024 / 1024, lastUpdate: now };
       }
       diskSizeMB = diskCache[serverId].sizeMB;
    }

    return {
      cpu: cpuPercent,
      ram: ramMB,
      disk: diskSizeMB,
      netIn: netIn,
      netOut: netOut,
      startedAt: info.State.StartedAt
    };
  } catch (e) {
    return { cpu: 0, ram: 0, disk: 0, netIn: 0, netOut: 0, startedAt: null };
  }
};

export const getContainerLogs = async (containerId: string, nodeId?: string): Promise<string> => {
  const docker = await getDocker(nodeId);
  if (isSandbox) return "[System] Sandbox mode. No historical logs available.\r\n";
  try {
    const container = docker.getContainer(containerId);
    const logsBuffer = await container.logs({ stdout: true, stderr: true, tail: 100 });
    return logsBuffer.toString('utf8');
  } catch (e) {
    return "";
  }
};

const activeStreams: Record<string, NodeJS.ReadWriteStream> = {};

export const attachContainerSocket = async (containerId: string, serverId: string, nodeId?: string) => {
  const docker = await getDocker(nodeId);
  if (isSandbox) return;

  try {
    const container = docker.getContainer(containerId);
    if (!activeStreams[containerId]) {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true, stdin: true });
      activeStreams[containerId] = stream;
      stream.on('data', (chunk) => {
        ioInstance?.to(`server_${serverId}`).emit("log", chunk.toString());
      });
      stream.on('end', () => {
        delete activeStreams[containerId];
      });
    }
  } catch(e) {
    console.error("Attach error", e);
  }
};

export const sendContainerCommand = async (containerId: string, command: string, nodeId?: string) => {
  const docker = await getDocker(nodeId);
  if (isSandbox) return;

  if (activeStreams[containerId]) {
    activeStreams[containerId].write(command + "\n");
  } else {
    try {
      const container = docker.getContainer(containerId);
      const stream = await container.attach({ stream: true, stdout: true, stderr: true, stdin: true });
      activeStreams[containerId] = stream;
      stream.write(command + "\n");
    } catch(e) {
       console.error("Command error", e);
    }
  }
};
