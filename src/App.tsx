/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { 
  Play, 
  Square, 
  Settings2, 
  Target, 
  Info, 
  Mic, 
  Zap,
  Trash2,
  Lock,
  Unlock,
  RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Constants ---
const MIN_FREQ = 1;
const MAX_FREQ = 30000;
const FFT_SIZE = 32768; 
const MIN_DB = -120;
const MAX_DB = 0;

type AppStatus = 'IDLE' | 'ARMED' | 'TRIGGERED' | 'ACTIVE' | 'PENDING_TRIGGER';

export default function App() {
  const [status, setStatus] = useState<AppStatus>('IDLE');
  const [thresholdDb, setThresholdDb] = useState(-36); // Trigger threshold in dB
  const [peakFreq, setPeakFreq] = useState(0);
  const [peakMag, setPeakMag] = useState(-Infinity);
  const [sampleRate, setSampleRate] = useState(44100);
  const [isDraggingThreshold, setIsDraggingThreshold] = useState(false);
  const [crosshairFreq, setCrosshairFreq] = useState(1000);
  const [crosshairDb, setCrosshairDb] = useState(-60);
  
  // Refs for audio processing
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Float32Array | null>(null);
  const peakHoldArrayRef = useRef<Float32Array | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const triggerTimeRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  // Initialize Audio
  const startAudio = async () => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        analyserRef.current = audioCtxRef.current.createAnalyser();
        analyserRef.current.fftSize = FFT_SIZE;
        analyserRef.current.smoothingTimeConstant = 0.2; 
      }

      // Important for iOS: resume context on user gesture
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const source = audioCtxRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      
      setSampleRate(audioCtxRef.current.sampleRate);
      dataArrayRef.current = new Float32Array(analyserRef.current.frequencyBinCount);
      peakHoldArrayRef.current = new Float32Array(analyserRef.current.frequencyBinCount).fill(-Infinity);
      
      setStatus('ACTIVE');
    } catch (err) {
      console.error('Microphone access denied:', err);
      alert('マイクへのアクセスを許可してください。');
    }
  };

  const stopAudio = () => {
    setStatus('IDLE');
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    
    // Explicitly stop all microphone tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    audioCtxRef.current?.close();
    audioCtxRef.current = null;
  };

  // Peak detection logic
  const detectPeak = (data: Float32Array, currentSampleRate: number) => {
    let maxVal = -Infinity;
    let maxIdx = -1;
    const binCount = data.length;
    
    const minBin = Math.max(1, Math.floor((1 * FFT_SIZE) / currentSampleRate));
    const maxBin = Math.floor((Math.min(MAX_FREQ, currentSampleRate / 2) * FFT_SIZE) / currentSampleRate);

    for (let i = minBin; i < Math.min(maxBin, binCount); i++) {
        if (data[i] > maxVal) {
            maxVal = data[i];
            maxIdx = i;
        }
    }

    if (maxIdx !== -1) {
        const freq = (maxIdx * currentSampleRate) / FFT_SIZE;
        setPeakFreq(Math.round(freq));
        setPeakMag(maxVal);
    }
  };

  const clearPeakHold = () => {
    if (peakHoldArrayRef.current) {
      peakHoldArrayRef.current.fill(-Infinity);
    }
    setPeakFreq(0);
    setPeakMag(-Infinity);
  };

  // Rendering Loop
  const render = useCallback(() => {
    if (!analyserRef.current || !dataArrayRef.current || !canvasRef.current || !peakHoldArrayRef.current) return;

    const ctx = canvasRef.current.getContext('2d', { alpha: false });
    if (!ctx) return;

    const width = canvasRef.current.width;
    const height = canvasRef.current.height;

    // Only update acoustic data if not triggered/stopped
    if (status !== 'TRIGGERED') {
      analyserRef.current.getFloatFrequencyData(dataArrayRef.current);

      // Check for trigger
      if (status === 'ARMED') {
        let maxAmp = -Infinity;
        for (let i = 0; i < dataArrayRef.current.length; i++) {
          if (dataArrayRef.current[i] > maxAmp) maxAmp = dataArrayRef.current[i];
        }

        if (maxAmp > thresholdDb) {
          setStatus('PENDING_TRIGGER');
          triggerTimeRef.current = performance.now();
        }
      }

      if (status === 'PENDING_TRIGGER') {
        if (performance.now() - triggerTimeRef.current > 500) {
            setStatus('TRIGGERED');
            detectPeak(peakHoldArrayRef.current, sampleRate);
        }
      }

      // Update Peak Hold
      for (let i = 0; i < dataArrayRef.current.length; i++) {
        if (dataArrayRef.current[i] > peakHoldArrayRef.current[i]) {
          peakHoldArrayRef.current[i] = dataArrayRef.current[i];
        }
      }
    }

    // Drawing Logic
    const getX = (freq: number) => {
        const logMin = Math.log10(MIN_FREQ);
        const logMax = Math.log10(MAX_FREQ);
        return ((Math.log10(freq) - logMin) / (logMax - logMin)) * width;
    };

    const getY = (db: number) => {
        return height - ((db - MIN_DB) / (MAX_DB - MIN_DB)) * height;
    };

    // Background
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, width, height);

    // Grid System
    ctx.strokeStyle = '#2A2A2A';
    ctx.lineWidth = 1;

    // Horizontal grid (dB)
    [-20, -40, -60, -80, -100].forEach(db => {
        const y = getY(db);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        
        ctx.fillStyle = '#444';
        ctx.font = '8px monospace';
        ctx.fillText(`${db}dB`, 5, y - 2);
    });

    // Vertical grid (Freq)
    const freqLabels = [10, 50, 100, 500, 1000, 5000, 10000, 20000, 30000];
    freqLabels.forEach(f => {
      const x = getX(f);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      ctx.fillStyle = f === 1000 ? '#F59E0B' : '#444';
      ctx.font = '8px monospace';
      ctx.fillText(f >= 1000 ? `${f/1000}k` : f.toString(), x + 2, height - 10);
    });

    // Draw Peak Hold (Amber)
    ctx.beginPath();
    ctx.strokeStyle = '#F59E0B'; 
    ctx.lineWidth = 2.5;
    let firstP = true;
    for (let i = 0; i < peakHoldArrayRef.current.length; i++) {
      const f = (i * sampleRate) / FFT_SIZE;
      if (f < MIN_FREQ) continue;
      if (f > MAX_FREQ) break;
      const x = getX(f);
      const y = getY(peakHoldArrayRef.current[i]);
      if (firstP) { ctx.moveTo(x, y); firstP = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under Peak Hold
    ctx.lineTo(width, height);
    ctx.lineTo(getX(MIN_FREQ), height);
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, 'rgba(245, 158, 11, 0.15)');
    grad.addColorStop(1, 'rgba(245, 158, 11, 0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw Live
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; 
    ctx.lineWidth = 1;
    let firstL = true;
    for (let i = 0; i < dataArrayRef.current.length; i++) {
      const f = (i * sampleRate) / FFT_SIZE;
      if (f < MIN_FREQ) continue;
      if (f > MAX_FREQ) break;
      const x = getX(f);
      const y = getY(dataArrayRef.current[i]);
      if (firstL) { ctx.moveTo(x, y); firstL = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw Threshold Line
    const threshY = getY(thresholdDb);
    ctx.beginPath();
    ctx.strokeStyle = '#ef4444'; 
    ctx.setLineDash([5, 5]);
    ctx.moveTo(0, threshY);
    ctx.lineTo(width, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Threshold Label
    ctx.fillStyle = '#ef4444';
    ctx.font = '10px monospace';
    ctx.fillText(`TRIGGER: ${thresholdDb.toFixed(1)} dB`, 10, threshY - 5);

    // Manual Crosshair display
    const hx = getX(crosshairFreq);
    const hy = getY(crosshairDb);
    
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.setLineDash([2, 2]);
    ctx.moveTo(hx, 0); ctx.lineTo(hx, height);
    ctx.moveTo(0, hy); ctx.lineTo(width, hy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    const label = `${Math.round(crosshairFreq)}Hz / ${crosshairDb.toFixed(1)}dB`;
    const labelWidth = ctx.measureText(label).width;
    
    const labelX = crosshairFreq >= 1000 ? hx - labelWidth - 15 : hx + 5;
    const labelY = hy < 25 ? hy + 25 : hy - 10;
    
    ctx.fillRect(labelX, labelY - 12, labelWidth + 10, 15);
    ctx.fillStyle = '#000';
    ctx.fillText(label, labelX + 5, labelY - 1);

    // Continue loop as long as system is not idle
    if (status !== 'IDLE') {
      rafIdRef.current = requestAnimationFrame(render);
    }
  }, [status, thresholdDb, sampleRate, crosshairFreq, crosshairDb]);

  useEffect(() => {
    if (status !== 'IDLE') {
      rafIdRef.current = requestAnimationFrame(render);
    }
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, [status, render]);

  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = canvasRef.current.clientWidth;
        canvasRef.current.height = canvasRef.current.clientHeight;
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Handle visibility change to stop mic when backgrounded
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && status !== 'IDLE') {
        stopAudio();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [status]);

  return (
    <div className="h-screen bg-[#0A0A0A] text-[#E0E0E0] font-sans flex flex-col overflow-hidden selection:bg-amber-500/30 select-none">
      <header className="h-10 border-b border-[#2A2A2A] px-4 flex items-center justify-between bg-[#111111] shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-amber-500 rounded-sm flex items-center justify-center text-black font-bold text-[10px]">W</div>
          <h1 className="text-[10px] font-medium tracking-tight uppercase tracking-widest">
            WOODTONE <span className="text-amber-500 font-bold italic">PRO</span> 
            <span className="text-[#666] font-mono ml-2 text-[8px] opacity-40">v2.5.1</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-4 text-[8px] uppercase tracking-widest font-mono">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(239,68,68,0.6)] ${status === 'ARMED' || status === 'PENDING_TRIGGER' ? 'bg-red-500 animate-pulse' : 'bg-gray-700'}`}></span>
              <span className={`${status === 'ARMED' || status === 'PENDING_TRIGGER' ? 'text-red-500' : 'text-[#666]'} font-bold`}>
                {status === 'ARMED' ? 'ARMED' : (status === 'PENDING_TRIGGER' ? 'CAPTURING...' : (status === 'IDLE' ? 'STANDBY' : 'READY'))}
              </span>
            </div>
            <div className="text-[#444]">{sampleRate/1000}kHz</div>
          </div>
          
          <div className="h-6 w-px bg-[#2A2A2A] hidden sm:block"></div>

          {status === 'IDLE' ? (
            <button 
              onClick={startAudio}
              className="h-7 bg-amber-500 text-black px-3 font-black rounded hover:bg-amber-400 transition-all flex items-center gap-1.5 shadow-[0_1.5px_0_rgb(180,83,9)] active:translate-y-[1px] active:shadow-none touch-manipulation text-[8px]"
            >
              <Play className="w-2.5 h-2.5 fill-current" /> INITIALIZE
            </button>
          ) : (
            <button 
              onClick={stopAudio}
              className="h-7 border border-[#333] bg-[#1a1a1a] text-[#888] px-3 font-black rounded hover:bg-[#222] transition-all flex items-center gap-1.5 touch-manipulation text-[8px]"
            >
              <Square className="w-2.5 h-2.5 fill-current" /> SHUTDOWN
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col p-1.5 md:p-2 gap-2 overflow-hidden">
        {/* Compact Stats Grid */}
        <div className="grid grid-cols-4 gap-1.5 shrink-0">
            <div className="bg-[#161616] border border-[#2A2A2A] p-2 rounded flex flex-col items-center">
              <div className="text-[7px] text-[#666] uppercase tracking-[0.2em] mb-0.5">Peak Freq</div>
              <div className="text-sm font-mono text-amber-500 font-bold leading-none">
                {peakFreq.toLocaleString()}<span className="text-[8px] ml-0.5 opacity-40">Hz</span>
              </div>
            </div>
            <div className="bg-[#161616] border border-[#2A2A2A] p-2 rounded flex flex-col items-center">
              <div className="text-[7px] text-[#666] uppercase tracking-[0.2em] mb-0.5">Peak Mag</div>
              <div className="text-sm font-mono text-[#E0E0E0] font-bold leading-none">
                {peakMag !== -Infinity ? peakMag.toFixed(1) : '--'}<span className="text-[8px] ml-0.5 opacity-40">dB</span>
              </div>
            </div>
            <div className="bg-[#161616] border border-[#2A2A2A] p-2 rounded flex flex-col items-center">
              <div className="text-[7px] text-[#666] uppercase tracking-[0.2em] mb-0.5">Trigger</div>
              <div className="text-sm font-mono text-red-500 font-bold leading-none">
                {thresholdDb.toFixed(0)}<span className="text-[8px] ml-0.5 opacity-40">dB</span>
              </div>
            </div>
            <div className="bg-[#161616] border border-[#2A2A2A] p-2 rounded flex flex-col items-center">
              <div className="text-[7px] text-[#666] uppercase tracking-[0.2em] mb-0.5">Status</div>
              <div className={`text-sm font-mono font-bold leading-none ${status === 'TRIGGERED' ? 'text-red-500' : (status === 'ARMED' ? 'text-amber-500' : (status === 'PENDING_TRIGGER' ? 'text-white' : 'text-cyan-500'))}`}>
                  {status === 'PENDING_TRIGGER' ? 'CAPTURE' : status}
              </div>
            </div>
        </div>

        {/* Main Spectrum Graph Area (Maximizing space) */}
        <div className="flex-1 min-h-0 flex flex-col gap-1.5">
          <div className="flex-1 bg-[#080808] border border-[#2A2A2A] rounded relative overflow-hidden flex flex-col shadow-inner">
             <div className="absolute top-2 right-2 z-10 hidden sm:flex gap-3 bg-black/60 p-1.5 rounded backdrop-blur-md border border-white/5 items-center">
                <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-0.5 bg-amber-500"></div>
                    <span className="text-[7px] font-mono text-white/50 uppercase tracking-widest">Peak</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-0.5 bg-white/20"></div>
                    <span className="text-[7px] font-mono text-white/50 uppercase tracking-widest">Live</span>
                </div>
                {status !== 'IDLE' && (
                  <div className="ml-2 flex items-center gap-1">
                    <span className="w-1 h-1 bg-red-500 rounded-full animate-pulse"></span>
                    <span className="text-[7px] font-mono text-red-500/80 uppercase">Sensors Active</span>
                  </div>
                )}
             </div>

            {status === 'IDLE' && (
               <div className="absolute inset-0 flex items-center justify-center bg-black/85 z-20 backdrop-blur-md">
                  <div className="text-center space-y-3 max-w-[180px]">
                    <div className="w-10 h-10 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center justify-center mx-auto">
                        <Mic className="w-5 h-5 text-amber-500" />
                    </div>
                    <button 
                      onClick={startAudio}
                      className="w-full py-2.5 bg-amber-500 text-black font-black text-[9px] uppercase tracking-widest hover:bg-amber-400 transition-colors shadow-xl"
                    >
                      Initialize System
                    </button>
                    <p className="text-[7px] text-[#444] uppercase tracking-widest leading-relaxed">
                      Precision Acoustic Logic
                    </p>
                  </div>
               </div>
            )}

            <div className="flex-1 relative overflow-hidden group touch-none">
              <canvas 
                ref={canvasRef}
                className="w-full h-full"
              />
            </div>
          </div>
          
          {/* Ultralight Controls Footer */}
          <div className="bg-[#111] border border-[#2A2A2A] rounded p-2 flex flex-col gap-2 shrink-0">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {/* Trigger Threshold */}
                  <div className="bg-[#1A1A1A]/50 px-2 py-1.5 rounded">
                      <div className="flex justify-between items-center mb-0.5">
                          <label className="text-[7px] uppercase tracking-[0.2em] text-[#555] font-bold">Trigger dB</label>
                          <span className={`text-[8px] font-mono font-bold ${status === 'IDLE' ? 'text-gray-700' : 'text-red-500'}`}>
                            {thresholdDb.toFixed(1)}
                          </span>
                      </div>
                      <input 
                        type="range" 
                        min={MIN_DB} 
                        max={MAX_DB} 
                        step="0.5" 
                        value={thresholdDb}
                        disabled={status === 'IDLE'}
                        onChange={(e) => setThresholdDb(parseFloat(e.target.value))}
                        className="w-full h-1 bg-[#222] rounded appearance-none cursor-pointer accent-red-500 disabled:opacity-10"
                      />
                  </div>

                  {/* Crosshair Freq */}
                  <div className="bg-[#1A1A1A]/50 px-2 py-1.5 rounded">
                      <div className="flex justify-between items-center mb-0.5">
                          <label className="text-[7px] uppercase tracking-[0.2em] text-[#555] font-bold">Freq Hz</label>
                          <span className={`text-[8px] font-mono font-bold ${status === 'IDLE' ? 'text-gray-700' : 'text-amber-500'}`}>
                            {Math.round(crosshairFreq)}
                          </span>
                      </div>
                      <input 
                        type="range" 
                        min={Math.log10(MIN_FREQ)} 
                        max={Math.log10(MAX_FREQ)} 
                        step="0.01" 
                        value={Math.log10(crosshairFreq)}
                        disabled={status === 'IDLE'}
                        onChange={(e) => setCrosshairFreq(Math.pow(10, parseFloat(e.target.value)))}
                        className="w-full h-1 bg-[#222] rounded appearance-none cursor-pointer accent-amber-500 disabled:opacity-10"
                      />
                  </div>

                  {/* Crosshair Level */}
                  <div className="bg-[#1A1A1A]/50 px-2 py-1.5 rounded">
                      <div className="flex justify-between items-center mb-0.5">
                          <label className="text-[7px] uppercase tracking-[0.2em] text-[#555] font-bold">Level dB</label>
                          <span className={`text-[8px] font-mono font-bold ${status === 'IDLE' ? 'text-gray-700' : 'text-cyan-500'}`}>
                            {crosshairDb.toFixed(1)}
                          </span>
                      </div>
                      <input 
                        type="range" 
                        min={MIN_DB} 
                        max={MAX_DB} 
                        step="0.5" 
                        value={crosshairDb}
                        disabled={status === 'IDLE'}
                        onChange={(e) => setCrosshairDb(parseFloat(e.target.value))}
                        className="w-full h-1 bg-[#222] rounded appearance-none cursor-pointer accent-cyan-500 disabled:opacity-10"
                      />
                  </div>
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-0.5">
                  <button 
                    onClick={() => setStatus(status === 'ARMED' ? 'ACTIVE' : 'ARMED')}
                    disabled={status === 'IDLE' || status === 'TRIGGERED' || status === 'PENDING_TRIGGER'}
                    className={`w-full h-8 rounded text-[9px] font-black uppercase tracking-[0.1em] transition-all flex items-center justify-center gap-1.5 touch-manipulation shadow-md ${
                      status === 'ARMED' 
                        ? 'bg-red-500 text-white shadow-[0_0_15px_rgba(239,68,68,0.3)]' 
                        : 'bg-[#2A2A2A] border border-white/5 text-amber-500 hover:bg-[#333] disabled:opacity-20'
                    }`}
                  >
                    {status === 'ARMED' ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                    {status === 'ARMED' ? 'ARMED' : 'ARM'}
                  </button>

                  <button 
                    onClick={() => {
                      if (status === 'ACTIVE' || status === 'ARMED' || status === 'PENDING_TRIGGER') {
                        setStatus('TRIGGERED');
                        if (peakHoldArrayRef.current) detectPeak(peakHoldArrayRef.current, sampleRate);
                      }
                    }}
                    disabled={status === 'IDLE' || status === 'TRIGGERED'}
                    className="w-full h-8 border border-[#2A2A2A] bg-[#2A2A2A]/20 text-cyan-500 text-[9px] font-black uppercase tracking-[0.1em] rounded hover:bg-[#333] disabled:opacity-20 transition-all flex items-center justify-center gap-1.5 touch-manipulation shadow-md px-1"
                  >
                    <Square className="w-3 h-3" /> STOP
                  </button>

                  <button 
                    onClick={() => {
                      clearPeakHold();
                      if (status === 'TRIGGERED') setStatus('ACTIVE');
                    }}
                    disabled={status === 'IDLE' || status === 'PENDING_TRIGGER'}
                    className="w-full h-8 border border-[#2A2A2A] bg-[#2A2A2A]/20 text-[#666] text-[9px] font-black uppercase tracking-[0.1em] rounded hover:bg-[#333] disabled:opacity-20 transition-all flex items-center justify-center gap-1.5 touch-manipulation shadow-md"
                  >
                    <RefreshCw className="w-3 h-3" /> RESET
                  </button>
              </div>
          </div>
        </div>
      </main>

      <footer className="h-5 bg-[#050505] border-t border-[#2A2A2A] px-3 flex items-center justify-between text-[7px] font-mono text-[#333] tracking-[0.2em] shrink-0 uppercase">
        <div className="flex gap-4">
          <span>{FFT_SIZE}pt FFT</span>
          <span>Log Scale (1Hz-30kHz)</span>
        </div>
        <div className="flex gap-2">
            <Info className="w-2 h-2" />
            <span>Acoustic Precision System</span>
        </div>
      </footer>
    </div>
  );
}
