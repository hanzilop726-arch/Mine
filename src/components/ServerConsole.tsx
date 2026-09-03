// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cpu, MemoryStick as MemoryIcon, HardDrive, Play, Square, RotateCw, Wifi, Clock, ArrowDown, ArrowUp, Terminal as TerminalIcon, Sparkles, Send
} from "lucide-react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "../context/AuthContext";
import axios from "axios";
import { AreaChart, Area, ResponsiveContainer, YAxis, Tooltip } from "recharts";
import { motion, AnimatePresence } from "framer-motion";

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
   ANIMATED CANVAS PARTICLES
═══════════════════════════════════════════════════════ */
const ParticleBackground = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = canvas.offsetWidth);
    let height = (canvas.height = canvas.offsetHeight);

    const particles: { x: number; y: number; vx: number; vy: number; radius: number; alpha: number }[] = [];
    const particleCount = 35;

    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        radius: Math.random() * 1.5 + 1,
        alpha: Math.random() * 0.5 + 0.2,
      });
    }

    const resize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
    };

    window.addEventListener("resize", resize);

    const render = () => {
      ctx.clearRect(0, 0, width, height);
      
      particles.forEach((p, idx) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(56, 189, 248, ${p.alpha})`;
        ctx.fill();

        for (let j = idx + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x;
          const dy = p.y - p2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 100) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(56, 189, 248, ${0.15 * (1 - dist / 100)})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-0 opacity-60" />;
};

/* ═══════════════════════════════════════════════════════
   PREMIUM SUB-COMPONENTS
═══════════════════════════════════════════════════════ */
const StatCard = ({ icon: Icon, label, value, dim, color, glow }: any) => (
  <motion.div 
    whileHover={{ y: -4, scale: 1.01 }}
    transition={{ duration: 0.2 }}
    className="relative group overflow-hidden bg-slate-900/40 backdrop-blur-xl border border-slate-800/80 rounded-2xl p-4 shadow-xl"
  >
    <div className={`absolute -right-6 -bottom-6 w-24 h-24 rounded-full blur-2xl opacity-15 group-hover:opacity-30 transition-opacity duration-500 ${glow}`} />
    <div className="flex items-center justify-between relative z-10">
      <div>
        <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{label}</span>
        <div className="text-lg font-bold text-white tracking-tight mt-1 flex items-baseline gap-1">
          {value} {dim && <span className="text-xs font-normal text-slate-500">{dim}</span>}
        </div>
      </div>
      <div className={`p-3 rounded-xl bg-slate-800/60 border border-slate-700/40 ${color} shadow-lg shadow-black/20`}>
        <Icon className="w-5 h-5" />
      </div>
    </div>
  </motion.div>
);

const ChartCard = ({ title, data, dataKey, dataKey2, max, strokeColor }: any) => {
  const chartData = useMemo(() => {
    let d = [...data];
    while (d.length < 30) {
      d.unshift({ [dataKey]: 0, ...(dataKey2 ? { [dataKey2]: 0 } : {}) });
    }
    return d;
  }, [data, dataKey, dataKey2]);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-slate-900/40 backdrop-blur-xl border border-slate-800/80 rounded-2xl p-5 shadow-2xl relative overflow-hidden"
    >
      <div className="flex justify-between items-center mb-4">
        <span className="text-xs font-bold text-slate-300 tracking-wider uppercase flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400" /> {title}
        </span>
      </div>
      <div className="h-40 w-full">
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
              contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(8px)', borderColor: 'rgba(51, 65, 85, 0.6)', borderRadius: '12px', fontSize: '12px' }} 
              itemStyle={{ color: '#e2e8f0' }}
            />
            <Area type="monotone" dataKey={dataKey} stroke={strokeColor} strokeWidth={2.5} fill={`url(#fill_${dataKey})`} isAnimationActive={false} />
            {dataKey2 && <Area type="monotone" dataKey={dataKey2} stroke="#10b981" strokeWidth={2.5} fillOpacity={0.15} fill="#10b981" isAnimationActive={false} />}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
};
/* ═══════════════════════════════════════════════════════
   MAIN COMPONENT LOGIC & RENDER
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
        // Fallback
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
      setLogs((p) => [...p, `[System Error] ${err?.message}`]);
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
    <div className="relative w-full max-w-[1600px] mx-auto p-4 sm:p-8 space-y-6 bg-[#06090e] text-slate-100 min-h-screen font-sans overflow-hidden">
      
      {/* CANVAS BACKGROUND */}
      <ParticleBackground />

      {/* LIGHT DECORATIONS */}
      <div className="absolute top-10 left-1/4 w-96 h-96 bg-cyan-600/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-10 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[120px] pointer-events-none" />

      {/* HEADER SECTION */}
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-900/50 border border-slate-800/80 p-5 rounded-2xl backdrop-blur-2xl shadow-2xl"
      >
        <div className="flex items-center gap-4">
          <div className="relative flex items-center justify-center">
            <span className={`absolute w-4 h-4 rounded-full ${isOnline ? 'bg-emerald-400 animate-ping opacity-75' : 'bg-rose-500/50'}`} />
            <span className={`relative w-3.5 h-3.5 rounded-full ${isOnline ? 'bg-emerald-400 shadow-[0_0_15px_#10b981]' : 'bg-rose-500'}`} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-2">
              {server?.name || "Minecraft Host"}
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] font-bold tracking-widest bg-cyan-950/80 text-cyan-400 px-2.5 py-0.5 rounded-full border border-cyan-800/50 uppercase">
                {stats.status?.toUpperCase() || "OFFLINE"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <motion.button 
            whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={() => executeAction('start')} 
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl text-xs tracking-wider uppercase shadow-lg shadow-emerald-950/50 border border-emerald-400/30 transition-all"
          >
            <Play className="w-4 h-4 fill-current" /> Start
          </motion.button>

          <motion.button 
            whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={() => executeAction('restart')} 
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-5 py-2.5 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white font-bold rounded-xl text-xs tracking-wider uppercase shadow-lg shadow-amber-950/50 border border-amber-400/30 transition-all"
          >
            <RotateCw className="w-4 h-4" /> Restart
          </motion.button>

          <motion.button 
            whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={() => executeAction('stop')} 
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-5 py-2.5 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white font-bold rounded-xl text-xs tracking-wider uppercase shadow-lg shadow-rose-950/50 border border-rose-400/30 transition-all"
          >
            <Square className="w-4 h-4 fill-current" /> Stop
          </motion.button>
        </div>
      </motion.div>

      {/* CONSOLE & STATS */}
      <div className="relative z-10 grid grid-cols-1 xl:grid-cols-4 gap-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="xl:col-span-3 bg-slate-950/80 border border-slate-800/80 rounded-2xl overflow-hidden flex flex-col h-[580px] shadow-2xl backdrop-blur-2xl relative"
        >
          <div className="bg-slate-900/90 px-5 py-3.5 border-b border-slate-800/80 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full bg-rose-500/80" />
                <span className="w-3 h-3 rounded-full bg-amber-500/80" />
                <span className="w-3 h-3 rounded-full bg-emerald-500/80" />
              </div>
              <span className="text-xs font-mono font-bold text-slate-400 tracking-widest uppercase ml-2 flex items-center gap-2">
                <TerminalIcon className="w-3.5 h-3.5 text-cyan-400" /> Console Stream
              </span>
            </div>
            <span className="text-[10px] font-mono text-slate-500 bg-slate-800/50 px-2 py-0.5 rounded border border-slate-700/40">SOCKET ACTIVE</span>
          </div>
          
          <div 
            ref={bodyRef} 
            onScroll={(e) => {
              const el = e.currentTarget;
              setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 30);
            }}
            className="flex-1 p-5 overflow-y-auto font-mono text-xs leading-relaxed space-y-1.5 bg-[#030712]/90 text-slate-300 selection:bg-cyan-500/30 selection:text-cyan-200"
          >
            {logs.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-600 italic font-sans text-sm">Listening for terminal logs...</div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="break-all hover:bg-slate-900/50 px-2 py-0.5 rounded transition-colors duration-150 flex items-start gap-2">
                  <span className="text-slate-600 select-none text-[10px] mt-0.5">›</span>
                  <span className={log.includes("WARN") ? "text-amber-400 font-medium" : log.includes("ERROR") ? "text-rose-400 font-bold" : log.startsWith(">") ? "text-cyan-400 font-bold" : "text-slate-300"}>
                    {stripAnsi(log)}
                  </span>
                </div>
              ))
            )}
          </div>

          <form onSubmit={send} className="flex items-center gap-3 p-3.5 bg-slate-900/90 border-t border-slate-800/80">
            <span className="text-cyan-400 font-mono font-black pl-2">$</span>
            <input 
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Type a server command..."
              className="flex-1 bg-transparent border-none outline-none text-xs font-mono text-white placeholder:text-slate-600 focus:ring-0"
            />
            <button type="submit" className="p-2 bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/30 rounded-lg text-cyan-400 transition-colors">
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>
        </motion.div>

        {/* SIDEBAR CARDS */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-3.5">
          <StatCard icon={Wifi} label="Server Address" value={server?.port ? `:${server.port}` : "25565"} color="text-cyan-400" glow="bg-cyan-500" />
          <StatCard icon={Cpu} label="CPU Load" value={isOnline ? `${stats.cpu.toFixed(1)}%` : '—'} dim={`/ ${stats.limitCpu}%`} color="text-indigo-400" glow="bg-indigo-500" />
          <StatCard icon={MemoryIcon} label="Memory Load" value={isOnline ? formatSize(stats.ram) : '—'} dim={`/ ${formatSize(stats.limitRam)}`} color="text-purple-400" glow="bg-purple-500" />
          <StatCard icon={HardDrive} label="Disk Storage" value={isOnline ? formatSize(stats.disk) : '—'} dim={`/ ${formatSize(stats.limitDisk)}`} color="text-amber-400" glow="bg-amber-500" />
          <StatCard icon={ArrowDown} label="Inbound Net" value={isOnline ? formatRate(netRates.in) : '—'} color="text-emerald-400" glow="bg-emerald-500" />
          <StatCard icon={ArrowUp} label="Outbound Net" value={isOnline ? formatRate(netRates.out) : '—'} color="text-rose-400" glow="bg-rose-500" />
        </div>
      </div>

      {/* CHARTS */}
      <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
        <ChartCard title="CPU Usage History" data={cpuHist} dataKey="cpu" max={stats.limitCpu} strokeColor="#38bdf8" />
        <ChartCard title="Memory Usage History" data={ramHist} dataKey="ram" max={stats.limitRam} strokeColor="#c084fc" />
        <ChartCard title="Network Traffic Speed" data={netHist} dataKey="netIn" dataKey2="netOut" max={100} strokeColor="#34d399" />
      </div>

    </div>
  );
}
