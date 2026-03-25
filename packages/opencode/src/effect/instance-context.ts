import { ServiceMap } from "effect"
import type { Project } from "@/project/project"

export declare namespace InstanceContext {
  export interface Info {
    readonly directory: string
    readonly worktree: string
    readonly project: Project.Info
  }
}

export class InstanceContext extends ServiceMap.Service<InstanceContext, InstanceContext.Info>()(
  "opencode/InstanceContext",
) {}
