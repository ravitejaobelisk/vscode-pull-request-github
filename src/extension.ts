/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { VSCodeConfiguration } from './authentication/vsConfiguration';
import { Resource } from './common/resources';
import { ReviewManager } from './view/reviewManager';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { PullRequestManager } from './github/pullRequestManager';
import { formatError, filterEvent, onceEvent } from './common/utils';
import { GitExtension, API as GitAPI, Repository } from './typings/git';
import { Telemetry } from './common/telemetry';
import { handler as uriHandler } from './common/uri';
import { ITelemetry } from './github/interface';

let telemetry: ITelemetry;

async function init(context: vscode.ExtensionContext, git: GitAPI, repository: Repository): Promise<void> {
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	const configuration = new VSCodeConfiguration();
	await configuration.loadConfiguration();
	configuration.onDidChange(async _ => {
		if (prManager) {
			try {
				await prManager.clearCredentialCache();
				if (repository) {
					repository.status();
				}
			} catch (e) {
				vscode.window.showErrorMessage(formatError(e));
			}
		}
	});

	context.subscriptions.push(configuration.listenForVSCodeChanges());

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

	const prManager = new PullRequestManager(configuration, repository, telemetry);
	const reviewManager = new ReviewManager(context, configuration, repository, prManager, telemetry);
	registerCommands(context, prManager, reviewManager, telemetry);

	/**
	 * Since selection changes are per repository, selecting a different repo will trigger two
	 * selection change events, one for the repository losing selection and one for the repository gaining selection.
	 * Try to debounce these so that only one update is done.
	 */
	let updateRepositoryTimer;
	git.repositories.forEach(repo => {
		(<any>repo).ui.onDidChange(_ => {
			if (updateRepositoryTimer) {
				clearTimeout(updateRepositoryTimer);
			}

			updateRepositoryTimer = setTimeout(() => {
				// no multi select support yet, always show PRs of first selected repository
				const firstSelectedRepository = git.repositories.filter(r => r.ui.selected)[0];
				if (firstSelectedRepository) {
					prManager.repository = firstSelectedRepository;
					reviewManager.repository = firstSelectedRepository;
				}
			}, 50);
		});
	});

	telemetry.on('startup');
}

export async function activate(context: vscode.ExtensionContext) {
	// initialize resources
	Resource.initialize(context);

	telemetry = new Telemetry(context);

	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git').exports;
	const git = gitExtension.getAPI(1);

	Logger.appendLine('Looking for git repository');
	const firstSelectedRepository = git.repositories.filter(r => r.ui.selected)[0];

	if (firstSelectedRepository) {
		await init(context, git, firstSelectedRepository);
	} else {
		const onDidOpenRelevantRepository = filterEvent(git.onDidOpenRepository, r => r.ui.selected);
		onceEvent(onDidOpenRelevantRepository)(r => init(context, git, r));
	}
}

export async function deactivate() {
	if (telemetry) {
		await telemetry.shutdown();
	}
}