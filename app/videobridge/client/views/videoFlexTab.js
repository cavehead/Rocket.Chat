import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Session } from 'meteor/session';
import { Template } from 'meteor/templating';
import { TimeSync } from 'meteor/mizzao:timesync';

import { settings } from '../../../settings';
import { modal, TabBar } from '../../../ui-utils';
import { t } from '../../../utils';
import { Users, Rooms } from '../../../models';
import * as CONSTANTS from '../../constants';

Template.videoFlexTab.helpers({
	openInNewWindow() {
		return settings.get('Jitsi_Open_New_Window');
	},
});

Template.videoFlexTab.onCreated(function() {
	this.tabBar = Template.currentData().tabBar;
});
Template.videoFlexTab.onDestroyed(function() {
	return this.stop && this.stop();
});

Template.videoFlexTab.onRendered(function() {
	this.api = null;

	const rid = Session.get('openedRoom');

	const width = 'auto';
	const height = 500;

	const configOverwrite = {
		desktopSharingChromeExtId: settings.get('Jitsi_Chrome_Extension'),
	};
	const interfaceConfigOverwrite = {};

	let jitsiRoomActive = null;

	const closePanel = () => {
		// Reset things.  Should probably be handled better in closeFlex()
		$('.flex-tab').css('max-width', '');
		$('.main-content').css('right', '');

		this.tabBar.close();

		TabBar.updateButton('video', { class: '' });
	};

	const stop = () => {
		if (this.intervalHandler) {
			Meteor.defer(() => this.api && this.api.dispose());
			clearInterval(this.intervalHandler);
		}
	};

	this.stop = stop;

	const start = () => {
		const update = () => {
			const { jitsiTimeout } = Rooms.findOne({ _id: rid }, { fields: { jitsiTimeout: 1 } });

			if (jitsiTimeout && (TimeSync.serverTime() - new Date(jitsiTimeout) + CONSTANTS.TIMEOUT < CONSTANTS.DEBOUNCE)) {
				return;
			}
			if (Meteor.status().connected) {
				return Meteor.call('jitsi:updateTimeout', rid);
			}
			closePanel();
			return this.stop();
		};
		update();
		this.intervalHandler = setInterval(update, CONSTANTS.HEARTBEAT);
		TabBar.updateButton('video', { class: 'red' });
	};

	modal.open({
		title: t('Video_Conference'),
		text: t('Start_video_call'),
		type: 'warning',
		showCancelButton: true,
		confirmButtonText: t('Yes'),
		cancelButtonText: t('Cancel'),
		html: false,
	}, (dismiss) => {
		if (!dismiss) {
			return closePanel();
		}
		this.intervalHandler = null;
		this.autorun(async () => {
			if (!settings.get('Jitsi_Enabled')) {
				return closePanel();
			}

			if (this.tabBar.getState() !== 'opened') {
				TabBar.updateButton('video', { class: '' });
				return stop();
			}

			const domain = settings.get('Jitsi_Domain');
			const jitsiRoom = settings.get('Jitsi_URL_Room_Prefix') + settings.get('uniqueID') + rid;
			const noSsl = !settings.get('Jitsi_SSL');
			const isEnabledTokenAuth = settings.get('Jitsi_Enabled_TokenAuth');

			if (jitsiRoomActive !== null && jitsiRoomActive !== jitsiRoom) {
				jitsiRoomActive = null;

				closePanel();

				return stop();
			}

			let accessToken = null;
			if (isEnabledTokenAuth) {
				accessToken = await new Promise((resolve, reject) => {
					Meteor.call('jitsi:generateAccessToken', rid, (error, result) => {
						if (error) {
							return reject(error);
						}
						resolve(result);
					});
				});
			}

			jitsiRoomActive = jitsiRoom;

			if (settings.get('Jitsi_Open_New_Window')) {
				Tracker.nonreactive(() => start());
				let queryString = '';
				if (accessToken) {
					queryString = `?jwt=${ accessToken }`;
				}

				const newWindow = window.open(`${ (noSsl ? 'http://' : 'https://') + domain }/${ jitsiRoom }${ queryString }`, jitsiRoom);
				if (newWindow) {
					const closeInterval = setInterval(() => {
						if (newWindow.closed === false) {
							return;
						}
						closePanel();
						stop();
						clearInterval(closeInterval);
					}, 300);
					return newWindow.focus();
				}
			}

			if (typeof JitsiMeetExternalAPI !== 'undefined') {
				// Keep it from showing duplicates when re-evaluated on variable change.
				const name = Users.findOne(Meteor.userId(), { fields: { name: 1 } });
				if (!$('[id^=jitsiConference]').length) {
					this.api = new JitsiMeetExternalAPI(domain, jitsiRoom, width, height, this.$('.video-container').get(0), configOverwrite, interfaceConfigOverwrite, noSsl, accessToken);

					/*
					* Hack to send after frame is loaded.
					* postMessage converts to events in the jitsi meet iframe.
					* For some reason those aren't working right.
					*/
					Meteor.setTimeout(() => this.api.executeCommand('displayName', [name]), 5000);
					return Tracker.nonreactive(() => start());
				}

				// Execute any commands that might be reactive.  Like name changing.
				this.api && this.api.executeCommand('displayName', [name]);
			}
		});
	});
});
