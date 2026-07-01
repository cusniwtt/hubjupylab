import React, { useEffect, useRef, useState } from 'react';

interface SSEConsoleProps {
  streamUrl: string;
  actionName: string;
  onComplete: (success: boolean) => void;
}

interface ProgressData {
  percent: number;
  speed?: string;
  eta?: string;
}

export const SSEConsole: React.FC<SSEConsoleProps> = ({ streamUrl, actionName, onComplete }) => {
  const [logs, setLogs] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState<string>('');
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let completed = false;
    setLogs([`[Client] Connecting to ${actionName} stream...`]);
    setCurrentFile('');
    setProgress(null);

    const es = new EventSource(streamUrl);
    eventSourceRef.current = es;

    es.addEventListener('progress', (event) => {
      try {
        const data = JSON.parse(event.data) as ProgressData;
        setProgress(data);
      } catch (e) {
        // Ignored
      }
    });

    es.onmessage = (event) => {
      const line = event.data.trim();
      if (!line) return;

      const isSummary =
        line.includes('sending incremental file list') ||
        line.includes('receiving incremental file list') ||
        line.includes('sent ') ||
        line.includes('total size is') ||
        line.includes('Starting rsync') ||
        line.includes('Sync complete') ||
        line.includes('Sync back complete') ||
        line.includes('failed') ||
        line.includes('Error:') ||
        line.startsWith('receiving incremental file list');

      if (!isSummary && line.length > 0) {
        setCurrentFile(line);
      }

      setLogs((prev) => [...prev, event.data]);

      if (event.data.includes('SUCCESS') || event.data.includes('failed') || event.data.includes('Error:')) {
        completed = true;
        es.close();
        onComplete(event.data.includes('SUCCESS'));
      }
    };

    es.onerror = () => {
      if (completed) return;
      setLogs((prev) => [...prev, '[Error] Sync stream disconnected.']);
      es.close();
      onComplete(false);
    };

    return () => {
      es.close();
    };
  }, [streamUrl, actionName]);

  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div
      id="sync_console_container"
      style={{
        background: '#090d16',
        border: '1px solid var(--border-color)',
        borderRadius: '6px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: '300px',
        marginTop: '1rem'
      }}
    >
      <div
        ref={consoleRef}
        id="sync_console"
        style={{
          flex: 1,
          padding: '1rem',
          fontFamily: "'Courier New', Courier, monospace",
          fontSize: '0.85rem',
          overflowY: 'auto',
          color: '#a855f7',
          whiteSpace: 'pre-wrap'
        }}
      >
        {logs.map((log, idx) => (
          <div key={idx}>{log}</div>
        ))}
      </div>

      {progress && (
        <div
          id="sync_progress_bar_container"
          style={{
            background: '#111827',
            borderTop: '1px solid var(--border-color)',
            padding: '0.75rem 1rem',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            fontFamily: "'Courier New', Courier, monospace",
            fontSize: '0.8rem',
            color: '#e9d5ff'
          }}
        >
          <span
            id="sync_progress_file"
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: '#c084fc'
            }}
          >
            {currentFile}
          </span>
          <div
            style={{
              width: '150px',
              height: '8px',
              background: '#1f2937',
              borderRadius: '4px',
              overflow: 'hidden',
              flexShrink: 0
            }}
          >
            <div
              id="sync_progress_fill"
              style={{
                width: `${progress.percent}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #a855f7, #6366f1)',
                transition: 'width 0.1s ease'
              }}
            ></div>
          </div>
          <span id="sync_progress_percent" style={{ fontWeight: 'bold', width: '40px', textAlign: 'right', flexShrink: 0 }}>
            {progress.percent}%
          </span>
          <span id="sync_progress_speed" style={{ width: '90px', textAlign: 'right', color: '#9ca3af', flexShrink: 0 }}>
            {progress.speed || ''}
          </span>
          <span id="sync_progress_eta" style={{ width: '70px', textAlign: 'right', color: '#9ca3af', flexShrink: 0 }}>
            {progress.eta || ''}
          </span>
        </div>
      )}
    </div>
  );
};
