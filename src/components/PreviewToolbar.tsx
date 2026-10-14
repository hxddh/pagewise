import { createPortal } from "react-dom";
import { useWorkspaceChrome, WorkspaceHeader, type WorkspaceHeaderProps } from "./WorkspaceHeader";

export type PreviewToolbarProps = WorkspaceHeaderProps;

/**
 * The preview pane's toolbar, which is no longer a toolbar of its own.
 *
 * Since 19.0 the document toolbar and the assistant panel's header are one
 * strip (`WorkspaceHeader`), rendered above both columns. The strip still
 * needs what only the preview pane knows — zoom, the thumbnails toggle,
 * region mode — so this component stays where `PreviewPane` mounts it and
 * hands those props to the header; the header draws itself into the
 * workspace's own slot through `WorkspaceChrome`, because the pane cannot
 * render outside its own box and the strip must.
 */
export function PreviewToolbar(props: PreviewToolbarProps) {
  const chrome = useWorkspaceChrome();
  if (!chrome?.slot) return null;
  return createPortal(<WorkspaceHeader {...props} />, chrome.slot);
}
