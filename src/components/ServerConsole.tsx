// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cpu, MemoryStick as MemoryIcon, HardDrive, Play, Square, RotateCw, Wifi, Clock, ArrowDown, ArrowUp, Terminal as TerminalIcon
} from "lucide-react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "../context/AuthContext";
import axios from "axios";
import { AreaChart, Area, ResponsiveContainer, YAxis, Tooltip } from "recharts";

/* ═══════════════════════════════════════════════════════
   TYPES & HELPERS
═══════════════════════════════════════════════════════ */
interface ServerStats {
  cpu: number;
  ram: number;
  disk: number;
  limitRam: number;
  limitCpu: number;
  limitDisk: number;
  netIn?: number;
  netOut?: number;
  startedAt?: string | null;
  status?: string;
}

interface ServerConsoleProps {
  serverId: string;
  server?: any;
}

const STATS_POLL_MS = 3000;
const SPARK_CAP = 30;

function stripAnsi(str: string) {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function formatSize(mb: number) {
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatRate(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}

/* ═══════════════════════════════════════════════════════
   COMPONENTS
═══════════════════════════════════════════════════════ */
const StatCard = ({ icon: Icon, label, value, dim, colorClass = "text-[#3b82f6]" }: any) => (
  <div className="relative bg-[#111622]/80 backdrop-blur-md border border-[#1e293b]/70 rounded-xl p-4 flex items-center justify-between transition-all duration-300 hover:border-[#334155] hover:shadow-lg group">
    <div className="flex flex-col">
      <span className="text-xs font-medium text-slate-400 mb-1 tracking-wide uppercase">{label}</span>
      <div className="text-lg font-bold text-white tracking-tight">
        {value} {dim && <span className="text-slate-500 text-xs font-normal">{dim}</span>}
      </div>
    </div>
    <div className={`p-3 rounded-lg bg-slate-800/50 ${colorClass} transition-transform group-hover:scale-110`}>
      <Icon className="w-5 h-5" />
    </div>
  </div>
);

const ChartCard = ({ title, data, dataKey, dataKey2, max, strokeColor = "#3b82f6", fillColor = "rgba(59, 130, 246, 0.2)" }: any) => {
  const chartData = useMemo(() => {
    let d = [...data];
    while (d.length < 30) {
      d.unshift({ [dataKey]: 0, ...(dataKey2 ? { [dataKey2]: 0 } : {}) });
    }
    return d;
  }, [data, dataKey, dataKey2]);

  return (
    <div className="bg-[#111622]/80 backdrop-blur-md border border-[#1e293b]/70 rounded-xl p-5 shadow-sm">
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm font-semibold text-slate-200">{title}</span>
      </div>
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 5, left: 0, right: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`fill_${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={strokeColor} stopOpacity={0.4} />
                <stop offset="95%" stopColor={strokeColor} stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <YAxis domain={[0, max || 'auto']} hide />
            <Tooltip 
              contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '12px' }} 
              itemStyle={{ color: '#e2e8f0' }}
            />
            <Area 
               type="monotone" 
               dataKey={dataKey} 
               stroke={strokeColor} 
               strokeWidth={2} 
               fill={`url(#fill_${dataKey})`} 
               isAnimationActive={false}
            />
            {dataKey2 && (
              <Area 
                 type="monotone" 
                 dataKey={dataKey2} 
                 stroke="#10b981" 
                 strokeWidth={2} 
                 fillOpacity={0.1}
                 fill="#10b981"
                 isAnimationActive={false}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════ */
export default function ServerConsole({ serverId, server }: ServerConsoleProps) {
  const { token } = useAuth();
  const [logs, setLogs] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  
  const [stats, setStats] = useState<ServerStats>({
    cpu: 0, ram: 0, disk: 0, limitRam: server?.ram || 1024, limitCpu: server?.cpu || 100, limitDisk: server?.disk || 10, status: server?.status || 'offline'
  });
  const [netRates, setNetRates] = useState({ in: 0, out: 0 });

  const [cpuHist, setCpuHist] = useState<any[]>([]);
  const [ramHist, setRamHist] = useState<any[]>([]);
  const [netHist, setNetHist] = useState<any[]>([]);
  
  const [atBottom, setAtBottom] = useState(true);
  const [uptime, setUptime] = useState(0);
  
  const sockRef = useRef<Socket | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevNetRef = useRef({ netIn: 0, netOut: 0, timestamp: 0 });
  const isVisible = useRef(true);

  useEffect(() => {
    const handleVisibility = () => { isVisible.current = !document.hidden; };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    if (!token || !serverId) return;
    const socket: Socket = io({
      auth: { token },
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
    });
    sockRef.current = socket;
    socket.on("connect", () => socket.emit("joinServer", serverId));
    socket.on("log", (data: string) => {
      if (typeof data !== "string") return;
      const lines = data.split(/\r?\n/).filter((l) => l.trim());
      setLogs((prev) => {
        const next = [...prev, ...lines];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    });
    return () => {
      socket.emit("leaveServer", serverId);
      socket.disconnect();
    };
  }, [serverId, token]);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      if (!alive || !isVisible.current) return;
      try {
        const { data } = await axios.get<ServerStats>(`/api/servers/${serverId}/stats`);
        if (alive && data) {
          setStats((p) => ({ ...p, ...data }));
          setCpuHist((h) => [...h, { cpu: data.cpu ?? 0 }].slice(-SPARK_CAP));
          setRamHist((h) => [...h, { ram: data.ram ?? 0 }].slice(-SPARK_CAP));
          
          const now = Date.now();
          if (prevNetRef.current.timestamp > 0 && data.netIn !== undefined && data.netOut !== undefined) {
            const elapsed = (now - prevNetRef.current.timestamp) / 1000;
            const inRate = Math.max(0, data.netIn - prevNetRef.current.netIn) / elapsed;
            const outRate = Math.max(0, data.netOut - prevNetRef.current.netOut) / elapsed;
            setNetRates({ in: inRate, out: outRate });
            setNetHist((h) => [...h, { netIn: inRate / 1024, netOut: outRate / 1024 }].slice(-SPARK_CAP));
          }
          prevNetRef.current = { netIn: data.netIn || 0, netOut: data.netOut || 0, timestamp: now };
        }
      } catch {
        // Fallback standard clear on failure
      }
    };
    pull();
    const iv = setInterval(pull, STATS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [serverId]);

  useEffect(() => {
    if (atBottom && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, atBottom]);

  const send = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = command.trim();
    if (!cmd) return;
    setCommand("");
    setLogs((p) => [...p, `> ${cmd}`]);
    try {
      await axios.post(`/api/servers/${serverId}/command`, { command: cmd });
    } catch (err: any) {
      setLogs((p) => [...p, `[System] Error: ${err?.message}`]);
    }
  }, [command, serverId]);

  const executeAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!server) return;
    try {
      await axios.post(`/api/servers/${server.id}/${action}`);
    } catch (error: any) {
      setLogs((p) => [...p, `[System Error] ${error.message}`]);
    }
  };

  const isOnline = stats.status === "online" || stats.status === "running";

  return (
    <div className="w-full max-w-7xl mx-auto p-4 sm:p-6 space-y-6 bg-[#0b0f17] text-slate-100 min-h-screen">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-[#111622]/80 border border-[#1e293b] p-4 rounded-xl backdrop-blur-md">
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full ${isOnline ? 'bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.8)]' : 'bg-rose-500'}`} />
          <h1 className="text-xl font-bold tracking-wide">{server?.name || "Minecraft Server"}</h1>
          <span className="text-xs bg-slate-800 text-slate-400 px-2.5 py-1 rounded-md font-mono border border-slate-700/50">
            {stats.status?.toUpperCase() || "OFFLINE"}
          </span>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button 
            onClick={() => executeAction('start')} 
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-medium rounded-lg text-sm transition-all shadow-lg shadow-emerald-950/40"
          >
            <Play className="w-4 h-4 fill-current" /> Start
          </button>
          <button 
            onClick={() => executeAction('restart')} 
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 active:scale-95 text-white font-medium rounded-lg text-sm transition-all shadow-lg shadow-amber-950/40"
          >
            <RotateCw className="w-4 h-4" /> Restart
          </button>
          <button 
            onClick={() => executeAction('stop')} 
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-medium rounded-lg text-sm transition-all shadow-lg shadow-rose-950/40"
          >
            <Square className="w-4 h-4 fill-current" /> Stop
          </button>
        </div>
      </div>

      {/* STATS & CONSOLE MAIN GRID */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
        
        {/* CONSOLE TERMINAL */}
        <div className="xl:col-span-3 bg-[#0d111a] border border-[#1e293b] rounded-xl overflow-hidden flex flex-col h-[550px] shadow-2xl">
          <div className="bg-[#161b26] px-4 py-3 border-b border-[#1e293b] flex items-center gap-2">
            <TerminalIcon className="w-4 h-4 text-slate-400" />
            <span className="text-xs font-semibold text-slate-300 font-mono tracking-wider">CONSOLE LOGS</span>
          </div>
          
          <div 
            ref={bodyRef} 
            onScroll={(e) => {
              const el = e.currentTarget;
              setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 30);
            }}
            className="flex-1 p-4 overflow-y-auto font-mono text-xs leading-relaxed space-y-1 bg-[#090d14] text-slate-300 selection:bg-slate-700"
          >
            {logs.length === 0 ? (
              <div className="text-slate-600 italic">Waiting for terminal stream output...</div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="break-all hover:bg-slate-900/40 px-1 py-0.5 rounded">
                  <span className="text-slate-600 select-none mr-2">›</span>
                  <span className={log.includes("WARN") ? "text-amber-400" : log.includes("ERROR") ? "text-rose-400 font-semibold" : log.startsWith(">") ? "text-sky-400 font-bold" : "text-slate-300"}>
                    {stripAnsi(log)}
                  </span>
                </div>
              ))
            )}
          </div>

          <form onSubmit={send} className="flex items-center gap-2 p-3 bg-[#111622] border-t border-[#1e293b]">
            <span className="text-sky-400 font-mono font-bold pl-2">$</span>
            <input 
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Send server command..."
              className="flex-1 bg-transparent border-none outline-none text-xs font-mono text-white placeholder:text-slate-600"
            />
          </form>
        </div>

        {/* STATS SIDEBAR */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-3">
          <StatCard icon={Wifi} label="Address" value={server?.port ? `:${server.port}` : "25565"} colorClass="text-sky-400" />
          <StatCard icon={Cpu} label="CPU Usage" value={isOnline ? `${stats.cpu.toFixed(1)}%` : '—'} dim={`/ ${stats.limitCpu}%`} colorClass="text-indigo-400" />
          <StatCard icon={MemoryIcon} label="Memory" value={isOnline ? formatSize(stats.ram) : '—'} dim={`/ ${formatSize(stats.limitRam)}`} colorClass="text-purple-400" />
          <StatCard icon={HardDrive} label="Disk Storage" value={isOnline ? formatSize(stats.disk) : '—'} dim={`/ ${formatSize(stats.limitDisk)}`} colorClass="text-amber-400" />
          <StatCard icon={ArrowDown} label="Network In" value={isOnline ? formatRate(netRates.in) : '—'} colorClass="text-emerald-400" />
          <StatCard icon={ArrowUp} label="Network Out" value={isOnline ? formatRate(netRates.out) : '—'} colorClass="text-rose-400" />
        </div>
      </div>

      {/* REALTIME CHARTS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <ChartCard title="CPU Load (%)" data={cpuHist} dataKey="cpu" max={stats.limitCpu} strokeColor="#818cf8" />
        <ChartCard title="Memory Usage (MB)" data={ramHist} dataKey="ram" max={stats.limitRam} strokeColor="#c084fc" />
        <ChartCard title="Network Speed (KB/s)" data={netHist} dataKey="netIn" dataKey2="netOut" max={100} strokeColor="#38bdf8" />
      </div>

    </div>
  );
        }
