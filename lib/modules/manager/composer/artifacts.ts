import is from '@sindresorhus/is';
import { quote } from 'shlex';
import {
  SYSTEM_INSUFFICIENT_DISK_SPACE,
  TEMPORARY_ERROR,
} from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { exec } from '../../../util/exec';
import type { ExecOptions, ToolConstraint } from '../../../util/exec/types';
import {
  ensureCacheDir,
  ensureLocalDir,
  getSiblingFileName,
  localPathExists,
  readLocalFile,
  writeLocalFile,
} from '../../../util/fs';
import { getRepoStatus } from '../../../util/git';
import * as hostRules from '../../../util/host-rules';
import { regEx } from '../../../util/regex';
import { GitTagsDatasource } from '../../datasource/git-tags';
import { PackagistDatasource } from '../../datasource/packagist';
import type { UpdateArtifact, UpdateArtifactsResult } from '../types';
import { ComposerConfig, ComposerLock } from './schema';
import type { AuthJson } from './types';
import {
  extractConstraints,
  findGithubToken,
  getComposerArguments,
  getPhpConstraint,
  requireComposerDependencyInstallation,
  takePersonalAccessTokenIfPossible,
} from './utils';

function getAuthJson(): string | null {
  const authJson: AuthJson = {};

  const githubToken = findGithubToken({
    hostType: 'github',
    url: 'https://api.github.com/',
  });

  const gitTagsGithubToken = findGithubToken({
    hostType: GitTagsDatasource.id,
    url: 'https://github.com',
  });

  const selectedGithubToken = takePersonalAccessTokenIfPossible(
    githubToken,
    gitTagsGithubToken
  );
  if (selectedGithubToken) {
    authJson['github-oauth'] = {
      'github.com': selectedGithubToken,
    };
  }

  hostRules.findAll({ hostType: 'gitlab' })?.forEach((gitlabHostRule) => {
    if (gitlabHostRule?.token) {
      const host = gitlabHostRule.resolvedHost ?? 'gitlab.com';
      authJson['gitlab-token'] = authJson['gitlab-token'] ?? {};
      authJson['gitlab-token'][host] = gitlabHostRule.token;
      // https://getcomposer.org/doc/articles/authentication-for-private-packages.md#gitlab-token
      authJson['gitlab-domains'] = [
        host,
        ...(authJson['gitlab-domains'] ?? []),
      ];
    }
  });

  hostRules
    .findAll({ hostType: PackagistDatasource.id })
    ?.forEach((hostRule) => {
      const { resolvedHost, username, password, token } = hostRule;
      if (resolvedHost && username && password) {
        authJson['http-basic'] = authJson['http-basic'] ?? {};
        authJson['http-basic'][resolvedHost] = { username, password };
      } else if (resolvedHost && token) {
        authJson.bearer = authJson.bearer ?? {};
        authJson.bearer[resolvedHost] = token;
      }
    });

  return is.emptyObject(authJson) ? null : JSON.stringify(authJson);
}

export async function updateArtifacts({
  packageFileName,
  updatedDeps,
  newPackageFileContent,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`composer.updateArtifacts(${packageFileName})`);

  const lockFileName = packageFileName.replace(regEx(/\.json$/), '.lock');
  const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
  if (!existingLockFileContent) {
    logger.debug('No composer.lock found');
    return null;
  }

  const vendorDir = getSiblingFileName(packageFileName, 'vendor');
  const commitVendorFiles = await localPathExists(vendorDir);
  await ensureLocalDir(vendorDir);
  try {
    await writeLocalFile(packageFileName, newPackageFileContent);

    const composerLockResult = ComposerLock.safeParse(
      JSON.parse(existingLockFileContent)
    );
    // istanbul ignore if
    if (!composerLockResult.success) {
      logger.warn(
        { error: composerLockResult.error },
        'Unable to parse composer.lock'
      );
      return null;
    }

    const newPackageFileResult = ComposerConfig.safeParse(
      JSON.parse(newPackageFileContent)
    );
    // istanbul ignore if
    if (!newPackageFileResult.success) {
      logger.warn(
        { error: newPackageFileResult.error },
        'Unable to parse composer.json'
      );
      return null;
    }

    const constraints = {
      ...extractConstraints(newPackageFileResult.data, composerLockResult.data),
      ...config.constraints,
    };

    const composerToolConstraint: ToolConstraint = {
      toolName: 'composer',
      constraint: constraints.composer,
    };

    const phpToolConstraint: ToolConstraint = {
      toolName: 'php',
      constraint: getPhpConstraint(constraints),
    };

    const execOptions: ExecOptions = {
      cwdFile: packageFileName,
      extraEnv: {
        COMPOSER_CACHE_DIR: await ensureCacheDir('composer'),
        COMPOSER_AUTH: getAuthJson(),
      },
      toolConstraints: [phpToolConstraint, composerToolConstraint],
      docker: {},
    };

    const commands: string[] = [];

    // Determine whether install is required before update
    if (requireComposerDependencyInstallation(composerLockResult.data)) {
      const preCmd = 'composer';
      const preArgs =
        'install' + getComposerArguments(config, composerToolConstraint);
      logger.trace({ preCmd, preArgs }, 'composer pre-update command');
      commands.push('git stash -- composer.json');
      commands.push(`${preCmd} ${preArgs}`);
      commands.push('git stash pop || true');
    }

    const cmd = 'composer';
    let args: string;
    if (config.isLockFileMaintenance) {
      args = 'update';
    } else {
      args =
        (
          'update ' +
          updatedDeps
            .map((dep) => dep.depName)
            .filter(is.string)
            .map((dep) => quote(dep))
            .join(' ')
        ).trim() + ' --with-dependencies';
    }
    args += getComposerArguments(config, composerToolConstraint);
    logger.trace({ cmd, args }, 'composer command');
    commands.push(`${cmd} ${args}`);

    await exec(commands, execOptions);
    const status = await getRepoStatus();
    if (!status.modified.includes(lockFileName)) {
      return null;
    }
    logger.debug('Returning updated composer.lock');
    const res: UpdateArtifactsResult[] = [
      {
        file: {
          type: 'addition',
          path: lockFileName,
          contents: await readLocalFile(lockFileName),
        },
      },
    ];

    if (!commitVendorFiles) {
      return res;
    }

    logger.debug(`Committing vendor files in ${vendorDir}`);
    for (const f of [...status.modified, ...status.not_added]) {
      if (f.startsWith(vendorDir)) {
        res.push({
          file: {
            type: 'addition',
            path: f,
            contents: await readLocalFile(f),
          },
        });
      }
    }
    for (const f of status.deleted) {
      res.push({
        file: {
          type: 'deletion',
          path: f,
        },
      });
    }

    return res;
  } catch (err) {
    // istanbul ignore if
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    if (
      err.message?.includes(
        'Your requirements could not be resolved to an installable set of packages.'
      )
    ) {
      logger.info('Composer requirements cannot be resolved');
    } else if (err.message?.includes('write error (disk full?)')) {
      throw new Error(SYSTEM_INSUFFICIENT_DISK_SPACE);
    } else {
      logger.debug({ err }, 'Failed to generate composer.lock');
    }
    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }
}
