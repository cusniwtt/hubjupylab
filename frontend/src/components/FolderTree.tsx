import React, { useState, useEffect } from 'react';
import { useToast } from './Toast';

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

interface FolderTreeProps {
  onSelect: (path: string) => void;
}

export const FolderTree: React.FC<FolderTreeProps> = ({ onSelect }) => {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const { addToast } = useToast();

  const fetchTree = async () => {
    setLoading(true);
    try {
      const response = await fetch('/session/gpu/list-dirs');
      if (!response.ok) throw new Error('Failed to load directories');
      const data = await response.json();
      setTree(data);
    } catch (err) {
      addToast('Error loading directory structure.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTree();
  }, []);

  const FolderNode: React.FC<{ node: TreeNode; depth: number }> = ({ node, depth }) => {
    const [isOpen, setIsOpen] = useState(false);
    const hasChildren = node.children && node.children.length > 0;

    return (
      <li style={{ margin: '0.2rem 0', listStyleType: 'none' }}>
        <div
          className="tree-row"
          style={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            padding: '0.25rem 0.4rem',
            borderRadius: '4px',
            fontSize: '0.875rem',
            color: 'var(--text-primary)',
            transition: 'all 0.15s ease',
            paddingLeft: `${depth * 1}rem`
          }}
          onClick={() => onSelect(node.path)}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          <span
            style={{
              marginRight: '0.3rem',
              fontFamily: 'monospace',
              display: 'inline-block',
              width: '12px',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              fontSize: '0.75rem',
              cursor: 'pointer'
            }}
            onClick={(e) => {
              if (hasChildren) {
                e.stopPropagation();
                setIsOpen(!isOpen);
              }
            }}
          >
            {hasChildren ? (isOpen ? '▼' : '▶') : ' '}
          </span>
          <span style={{ marginRight: '0.4rem', fontSize: '0.9rem' }}>📁</span>
          <span style={{ userSelect: 'none' }}>{node.name}</span>
        </div>
        {hasChildren && isOpen && (
          <ul style={{ margin: 0, padding: 0 }}>
            {node.children!.map((child) => (
              <FolderNode key={child.path} node={child} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div
      id="tree_container"
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: '6px',
        padding: '0.5rem',
        maxHeight: '200px',
        overflowY: 'auto',
        background: 'rgba(15, 23, 42, 0.4)',
        backdropFilter: 'blur(4px)',
        marginTop: '0.5rem'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          padding: '0.3rem 0.4rem',
          borderRadius: '4px',
          fontSize: '0.875rem',
          fontWeight: '600',
          color: 'var(--accent-color)',
          marginBottom: '0.25rem'
        }}
        onClick={() => onSelect('')}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(99, 102, 241, 0.15)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <span style={{ marginRight: '0.4rem', width: '12px', display: 'inline-block' }}></span>
        <span style={{ marginRight: '0.4rem' }}>🏠</span>
        [Sync Entire Workspace]
      </div>

      {loading ? (
        <div style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          Loading directories...
        </div>
      ) : tree.length === 0 ? (
        <div style={{ padding: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          No subdirectories found.
        </div>
      ) : (
        <ul style={{ margin: 0, padding: 0 }}>
          {tree.map((node) => (
            <FolderNode key={node.path} node={node} depth={0} />
          ))}
        </ul>
      )}
    </div>
  );
};
