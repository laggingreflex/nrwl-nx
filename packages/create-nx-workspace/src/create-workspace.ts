import { CreateWorkspaceOptions } from './create-workspace-options';
import { output } from './utils/output';
import {
  createNxCloudOnboardingUrl,
  getNxCloudInfo,
  readNxCloudToken,
} from './utils/nx/nx-cloud';
import { createSandbox } from './create-sandbox';
import { createEmptyWorkspace } from './create-empty-workspace';
import { createPreset } from './create-preset';
import { setupCI } from './utils/ci/setup-ci';
import {
  initializeGitRepo,
  pushToGitHub,
  VcsPushStatus,
} from './utils/git/git';
import { getPackageNameFromThirdPartyPreset } from './utils/preset/get-third-party-preset';
import { mapErrorToBodyLines } from './utils/error-utils';
import { Preset } from './utils/preset/preset';

export async function createWorkspace<T extends CreateWorkspaceOptions>(
  preset: string,
  options: T,
  rawArgs?: T
) {
  const {
    packageManager,
    name,
    nxCloud,
    skipGit = false,
    defaultBase = 'main',
    commit,
    cliName,
    useGitHub,
    skipGitHubPush = false,
    verbose = false,
  } = options;

  if (cliName) {
    output.setCliName(cliName ?? 'NX');
  }

  const tmpDir = await createSandbox(packageManager);

  const workspaceGlobs = getWorkspaceGlobsFromPreset(preset);

  // nx new requires a preset currently. We should probably make it optional.
  const directory = await createEmptyWorkspace<T>(
    tmpDir,
    name,
    packageManager,
    { ...options, preset, workspaceGlobs }
  );

  // If the preset is a third-party preset, we need to call createPreset to install it
  // For first-party presets, it will be created by createEmptyWorkspace instead.
  // In createEmptyWorkspace, it will call `nx new` -> `@nx/workspace newGenerator` -> `@nx/workspace generatePreset`.
  const thirdPartyPackageName = getPackageNameFromThirdPartyPreset(preset);
  if (thirdPartyPackageName) {
    await createPreset(
      thirdPartyPackageName,
      options,
      packageManager,
      directory
    );
  }

  let connectUrl: string | undefined;
  let nxCloudInfo: string | undefined;
  if (nxCloud !== 'skip') {
    const token = readNxCloudToken(directory) as string;

    if (nxCloud !== 'yes') {
      await setupCI(directory, nxCloud, packageManager);
    }

    connectUrl = await createNxCloudOnboardingUrl(
      nxCloud,
      token,
      directory,
      useGitHub
    );
  }

  let pushedToVcs = VcsPushStatus.SkippedGit;

  if (!skipGit) {
    try {
      await initializeGitRepo(directory, { defaultBase, commit, connectUrl });

      // Push to GitHub if commit was made, GitHub push is not skipped, and CI provider is GitHub
      if (commit && !skipGitHubPush && nxCloud === 'github') {
        pushedToVcs = await pushToGitHub(directory, {
          skipGitHubPush,
          name,
          defaultBase,
          verbose,
        });
      }
    } catch (e) {
      if (e instanceof Error) {
        output.error({
          title: 'Could not initialize git repository',
          bodyLines: mapErrorToBodyLines(e),
        });
      } else {
        console.error(e);
      }
    }
  }

  if (connectUrl) {
    nxCloudInfo = await getNxCloudInfo(
      nxCloud,
      connectUrl,
      pushedToVcs,
      rawArgs?.nxCloud
    );
  }

  return {
    nxCloudInfo,
    directory,
    pushedToVcs,
  };
}

export function extractConnectUrl(text: string): string | null {
  const urlPattern = /(https:\/\/[^\s]+\/connect\/[^\s]+)/g;
  const match = text.match(urlPattern);
  return match ? match[0] : null;
}

function getWorkspaceGlobsFromPreset(preset: string): string[] {
  // Should match how apps are created in `packages/workspace/src/generators/preset/preset.ts`.
  switch (preset) {
    case Preset.AngularMonorepo:
    case Preset.Expo:
    case Preset.Express:
    case Preset.Nest:
    case Preset.NextJs:
    case Preset.NodeMonorepo:
    case Preset.Nuxt:
    case Preset.ReactNative:
    case Preset.ReactMonorepo:
    case Preset.VueMonorepo:
    case Preset.WebComponents:
      return ['apps/*'];
    default:
      return ['packages/*'];
  }
}
