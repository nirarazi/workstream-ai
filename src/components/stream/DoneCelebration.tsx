import { useState, useEffect, useMemo } from "react";

interface DoneCelebrationProps {
  onComplete: () => void;
}

interface Particle {
  id: number;
  angle: number;
  distance: number;
  size: number;
  color: string;
  delay: number;
  duration: number;
}

const PARTICLE_COLORS = [
  "#4ade80", // green-400
  "#22d3ee", // cyan-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#34d399", // emerald-400
  "#86efac", // green-300
];

const PARTICLE_COUNT = 24;

export default function DoneCelebration({ onComplete }: DoneCelebrationProps) {
  const [phase, setPhase] = useState<"burst" | "settle" | "out">("burst");

  const particles = useMemo<Particle[]>(() =>
    Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      id: i,
      angle: (360 / PARTICLE_COUNT) * i + (Math.random() * 20 - 10),
      distance: 40 + Math.random() * 50,
      size: 2 + Math.random() * 3,
      color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
      delay: Math.random() * 150,
      duration: 400 + Math.random() * 300,
    })),
  []);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase("settle"), 600),
      setTimeout(() => setPhase("out"), 1600),
      setTimeout(onComplete, 2200),
    ];
    return () => timers.forEach(clearTimeout);
  }, [onComplete]);

  return (
    <div
      className={`absolute inset-0 z-20 flex items-center justify-center pointer-events-none transition-opacity duration-500 ${
        phase === "out" ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Glow backdrop */}
      <div
        className={`absolute inset-0 transition-opacity duration-700 ${
          phase === "burst" ? "opacity-100" : "opacity-0"
        }`}
        style={{
          background: "radial-gradient(circle at center, rgba(34,197,94,0.08) 0%, transparent 60%)",
        }}
      />

      {/* Particle burst */}
      <div className="relative">
        {particles.map((p) => {
          const rad = (p.angle * Math.PI) / 180;
          const x = Math.cos(rad) * p.distance;
          const y = Math.sin(rad) * p.distance;
          return (
            <span
              key={p.id}
              className="absolute rounded-full"
              style={{
                width: p.size,
                height: p.size,
                backgroundColor: p.color,
                left: "50%",
                top: "50%",
                marginLeft: -p.size / 2,
                marginTop: -p.size / 2,
                opacity: 0,
                animation: `done-particle ${p.duration}ms ease-out ${p.delay}ms forwards`,
                ["--tx" as string]: `${x}px`,
                ["--ty" as string]: `${y}px`,
              }}
            />
          );
        })}

        {/* Checkmark ring */}
        <div className="relative w-16 h-16 flex items-center justify-center">
          <svg viewBox="0 0 64 64" className="w-16 h-16">
            {/* Ring */}
            <circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              stroke="rgba(34,197,94,0.3)"
              strokeWidth="2"
              className="done-ring"
            />
            {/* Checkmark */}
            <path
              d="M20 33 L28 41 L44 24"
              fill="none"
              stroke="#4ade80"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="done-check"
            />
          </svg>
        </div>
      </div>

      {/* Label */}
      <div
        className={`absolute mt-28 text-sm font-medium text-green-400 transition-all duration-500 ${
          phase === "burst"
            ? "opacity-0 translate-y-2"
            : phase === "settle"
              ? "opacity-100 translate-y-0"
              : "opacity-0 -translate-y-1"
        }`}
      >
        Done
      </div>
    </div>
  );
}
