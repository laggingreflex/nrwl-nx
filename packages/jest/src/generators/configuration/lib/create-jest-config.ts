import {
  createProjectGraphAsync,
  readNxJson,
  readProjectConfiguration,
  stripIndents,
  updateProjectConfiguration,
  type TargetConfiguration,
  type Tree,
} from '@nx/devkit';
import { readTargetDefaultsForTarget } from 'nx/src/project-graph/utils/project-configuration-utils';
import { findRootJestConfig } from '../../../utils/config/find-root-jest-files';
import type { NormalizedJestProjectSchema } from '../schema';

export async function createJestConfig(
  tree: Tree,
  options: Partial<NormalizedJestProjectSchema>,
  presetExt: 'cjs' | 'js'
) {
  if (!tree.exists(`jest.preset.${presetExt}`)) {
    // preset is always js file.
    tree.write(
      `jest.preset.${presetExt}`,
      `
      const nxPreset = require('@nx/jest/preset').default;

      module.exports = { ...nxPreset }`
    );
  }
  if (options.rootProject) {
    // we don't want any config to be made because the `configurationGenerator` will do it.
    // will copy the template config file
    return;
  }
  const rootJestPath = findRootJestConfig(tree);
  if (!rootJestPath) {
    // if there's not root jest config, we will create one and return
    // this can happen when:
    // - root jest config was renamed => in which case there is migration needed
    // - root project didn't have jest setup => again, no migration is needed
    generateGlobalConfig(tree, options.js);
    return;
  }

  if (tree.exists(rootJestPath)) {
    // moving from root project config to monorepo-style config
    const { nodes: projects } = await createProjectGraphAsync();
    const projectConfigurations = Object.values(projects);
    const rootProject = projectConfigurations.find(
      (projectNode) => projectNode.data?.root === '.'
    );
    // root project might have been removed,
    // if it's missing there's nothing to migrate
    if (rootProject) {
      const jestTarget = Object.entries(rootProject.data?.targets ?? {}).find(
        ([_, t]) =>
          ((t?.executor === '@nx/jest:jest' ||
            t?.executor === '@nrwl/jest:jest') &&
            t?.options?.jestConfig === rootJestPath) ||
          (t?.executor === 'nx:run-commands' && t?.options?.command === 'jest')
      );
      if (!jestTarget) {
        return;
      }

      const [jestTargetName, jestTargetConfigInGraph] = jestTarget;
      // if root project doesn't have jest target, there's nothing to migrate
      const rootProjectConfig = readProjectConfiguration(
        tree,
        rootProject.name
      );

      if (
        rootProjectConfig.targets['test']?.executor === 'nx:run-commands'
          ? rootProjectConfig.targets['test']?.command !== 'jest'
          : rootProjectConfig.targets['test']?.options?.jestConfig !==
            rootJestPath
      ) {
        // Jest target has already been updated
        return;
      }

      const jestProjectConfig = `jest.config.${
        rootProjectConfig.projectType === 'application' ? 'app' : 'lib'
      }.${options.js ? 'js' : 'ts'}`;

      tree.rename(rootJestPath, jestProjectConfig);

      const nxJson = readNxJson(tree);
      const targetDefaults = readTargetDefaultsForTarget(
        jestTargetName,
        nxJson.targetDefaults,
        jestTargetConfigInGraph.executor
      );

      const target: TargetConfiguration = (rootProjectConfig.targets[
        jestTargetName
      ] ??=
        jestTargetConfigInGraph.executor === 'nx:run-commands'
          ? { command: `jest --config ${jestProjectConfig}` }
          : {
              executor: jestTargetConfigInGraph.executor,
              options: {},
            });

      if (target.executor === '@nx/jest:jest') {
        target.options.jestConfig = jestProjectConfig;
      }

      if (targetDefaults?.cache === undefined) {
        target.cache = jestTargetConfigInGraph.cache;
      }
      if (targetDefaults?.inputs === undefined) {
        target.inputs = jestTargetConfigInGraph.inputs;
      }
      if (targetDefaults?.outputs === undefined) {
        target.outputs = jestTargetConfigInGraph.outputs;
      }
      if (targetDefaults?.dependsOn === undefined) {
        target.dependsOn = jestTargetConfigInGraph.dependsOn;
      }

      updateProjectConfiguration(tree, rootProject.name, rootProjectConfig);
      // generate new global config as it was move to project config or is missing
      generateGlobalConfig(tree, options.js);
    }
  }
}

function generateGlobalConfig(tree: Tree, isJS: boolean) {
  const contents = isJS
    ? stripIndents`
    const { getJestProjects } = require('@nx/jest');

    module.exports = {
      projects: getJestProjects()
    };`
    : stripIndents`
    import { getJestProjects } from '@nx/jest';

    export default {
     projects: getJestProjects()
    };`;
  tree.write(`jest.config.${isJS ? 'js' : 'ts'}`, contents);
}
