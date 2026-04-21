import { useState, useEffect } from "react";

interface SendConfirmationProps {
  channelName: string;
  action: string;
  onComplete: () => void;
}

export default function SendConfirmation({ channelName, action, onComplete }: SendConfirmationProps) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setStep(1), 400),   // checkmark
      setTimeout(() => setStep(2), 1000),  // delivery confirmation
      setTimeout(() => setStep(3), 2000),  // resolve message
      setTimeout(onComplete, 3000),         // cleanup
    ];
    return () => timers.forEach(clearTimeout);
  }, [onComplete]);

  const actionLabels: Record<string, string> = {
    // Server action names
    redirect: "Unblocked",
    approve: "Done",
    close: "Dismissed",
    noise: "Classified as noise",
    // ActionKind names
    unblock: "Unblocked",
    done: "Done",
    dismiss: "Dismissed",
    snooze: "Snoozed",
  };

  return (
    <div className="text-center py-3">
      {step >= 1 && (
        <div className="text-[10px] text-green-400 animate-fade-in">
          ✓ Sent to #{channelName}
        </div>
      )}
      {step >= 2 && (
        <div className="text-[10px] text-green-500/70 mt-1 animate-fade-in">
          Delivered to Slack · #{channelName} thread
        </div>
      )}
      {step >= 3 && (
        <div className="mt-2">
          <div className="text-[10px] text-green-400 font-medium">
            ✓ {actionLabels[action] ?? "Done"} · leaving stream
          </div>
          <div className="text-[9px] text-gray-600 mt-0.5">
            Will reappear if agent needs you again
          </div>
        </div>
      )}
    </div>
  );
}
