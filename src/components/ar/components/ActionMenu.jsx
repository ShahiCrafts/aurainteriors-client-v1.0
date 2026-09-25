import React from "react";
import { IoColorPaletteOutline, IoCameraOutline, IoTrashOutline } from "react-icons/io5";

const ActionMenu = ({ show, hasPlacedModel, onCustomize, onCapture, onRemove }) => {
  if (!show || !hasPlacedModel) return null;

  const actions = [
    { icon: IoColorPaletteOutline, label: "Style", onClick: onCustomize },
    { icon: IoCameraOutline, label: "Save", onClick: onCapture },
    { icon: IoTrashOutline, label: "Remove", onClick: onRemove, danger: true },
  ];

  return (
    <div className="absolute right-4 top-1/2 z-50 -translate-y-1/2" data-hide-on-capture>
      <div className="flex flex-col gap-2 rounded-[22px] border border-white/10 bg-black/55 p-2 shadow-2xl backdrop-blur-2xl">
        {actions.map(({ icon: Icon, label, onClick, danger }) => (
          <button
            key={label}
            onClick={onClick}
            className={`group flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-2xl transition active:scale-95 ${danger ? "text-rose-300 hover:bg-rose-400/10" : "text-white hover:bg-white/10"}`}
            aria-label={label}
          >
            <Icon size={20} />
            <span className="text-[9px] font-medium text-white/60 group-hover:text-current">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default ActionMenu;
