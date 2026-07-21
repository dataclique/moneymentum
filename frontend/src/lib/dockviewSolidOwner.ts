import type { Owner } from "solid-js"

let dockviewSolidOwner: Owner | null = null

/** Bind the Solid owner that dockview panel portals should inherit (providers). */
export const bindDockviewSolidOwner = (owner: Owner | null): void => {
  dockviewSolidOwner = owner
}

export const readDockviewSolidOwner = (): Owner | null => dockviewSolidOwner
