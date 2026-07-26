import { DatabaseService } from '../db/database.js';
import { PROVIDERS } from '../config/providers.js';
import { assertMasterWriteAllowed } from '../db/schema.js';
import { HelmIdentityService } from './helm-identity-service.js';

export interface MasterModelEntry {
  position: number;
  provider: string;
  model: string;
}

export class MasterModelService {
  private readonly identity?: HelmIdentityService;

  constructor(private readonly db: DatabaseService, identity?: HelmIdentityService) {
    this.identity = identity;
  }

  getChain(projectId: number): MasterModelEntry[] {
    return this.db.prepare('SELECT position, provider, model FROM project_master_models WHERE project_id = ? ORDER BY position').all(projectId) as MasterModelEntry[];
  }

  setChain(projectId: number, chain: Array<{provider: string; model: string}>) {
    if (this.identity) {
      // AC2: fail closed BEFORE any model-chain mutation on an inactive/unknown native project.
      const resolution = this.identity.resolveProject(projectId);
      if (!resolution.project) throw new Error('unknown OVM project');
    }
    for (const {provider, model} of chain) {
      // B1 (kloo/D-OQ2): explicit reject kloo as a persistent master (v1 = Agent Studio agents +
      // test-chat only, not a project master; see decisions.md OQ2). Checked BEFORE the models[]
      // lookup below because kloo is a dynamic provider (models[] is intentionally empty), so the
      // generic "unknown {provider,model}" error would be misleading here.
      if (provider === 'kloo') {
        throw new Error('kloo is not supported as a project master in v1 (Agent Studio agents + test-chat only)');
      }
      // B25d: fail closed on provider ∉ PROVIDERS / model not allow-listed (clear error).
      assertMasterWriteAllowed(provider, model);
      const p = PROVIDERS[provider as keyof typeof PROVIDERS];
      if (!p || !p.models.some((m: any) => m.model === model)) {
        throw new Error(`unknown {provider,model}: ${provider}/${model}`);
      }
      // RTF-H1 MED: explicit reject claude as persistent master (per brief; skill can't bare-launch master in P1)
      if (provider === 'claude') {
        throw new Error('claude is not supported as a persistent master in P1; use grok or codex');
      }
      // H5: reject at set time (clear error) rather than runtime 500 in launchMaster
      const mode = p.launch.defaultMode;
      if (!(p.launch.templates as Record<string, string>)[mode]) {
        throw new Error(`provider ${provider} defaultMode ${mode} has no launch template and cannot be launched as master`);
      }
    }
    this.db.prepare('DELETE FROM project_master_models WHERE project_id = ?').run(projectId);
    const ins = this.db.prepare('INSERT INTO project_master_models (project_id, position, provider, model) VALUES (?,?,?,?)');
    chain.forEach((c, i) => ins.run(projectId, i, c.provider, c.model));
  }

  isSetUp(projectId: number): boolean {
    return this.getChain(projectId).length > 0;
  }
}
