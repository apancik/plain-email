"use strict";

// Temporary fix Unable to verify leaf signature
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

// =======
// MODULES
// =======

// Electron core modules
var electron = require("electron");
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var ipc = electron.ipcMain;
var Menu = electron.Menu;
var autoUpdater = electron.autoUpdater;

// Vendor modules
var os = require("os").platform();
var env = require("./vendor/electron_boilerplate/env_config");
var pjson = require("./package.json");
var jetpack = require("fs-jetpack");

require("electron-dl")();

// Google APIs
var google = require("googleapis");
var OAuth2 = google.auth.OAuth2;
var plus = google.plus("v1");

// Email receiving and parsing
var ImapClient = require("emailjs-imap-client");
var simpleParser = require("mailparser").simpleParser;

// Cleaning html email components
var document = require("jsdom").jsdom("", {
	FetchExternalResources: false,
	ProcessExternalResources: false
});
var DOMPurify = require("dompurify")(document.defaultView);

// Text email components
var linkify = require("html-linkify");
var htmlToText = require("html-to-text");

// Email sending
var nodemailer = require("nodemailer");

// Helper modules
var async = require("async");
var _ = require("underscore");
var colors = require("colors");
var moment = require("moment");

// ===========
// AUTOUPDATER
// ===========
function setupAutoUpdater (event) {
	if (env.name === "production") {
		log("CHECKING FOR UPDATES".green);

		autoUpdater.setFeedURL("http://www.plainemail.com/updates/latest?v=" + pjson.version);

		autoUpdater.on("update-available", function () {
			log("Update is available. Downloading".green);
		});

		autoUpdater.on("update-not-available", function () {
			log("Update is not available.".green);
		});

		autoUpdater.on("error", function (error) {
			log("Error downloading the update".red, error);
		});

		autoUpdater.on("update-downloaded", function () {
			event.sender.send("update-available");			
		});

		autoUpdater.checkForUpdates();
	} else {
		log("NOT CHECKING FOR UPDATES".red);
	}
}

// ====
// MENU
// ====
var mainMenu = [{
		label: "Application",
		submenu: [{
			label: "Clear cache and reload",
			accelerator: "CmdOrCtrl+R",
			click: function () {
				log("RELOADING".blue);
				currentEmail = {};
				cachedEmails = {};
				if(BrowserWindow.getFocusedWindow()) {
					BrowserWindow.getFocusedWindow().webContents.reloadIgnoringCache();
				}				
			}
        }, {
			label: "Quit",
			accelerator: "CmdOrCtrl+Q",
			click: function () {
				app.quit();
			}
		}
    ]}, {
		label: "Edit",
		submenu: [
			{
				label: "Undo",
				accelerator: "CmdOrCtrl+Z",
				selector: "undo:"
			},
			{
				label: "Redo",
				accelerator: "Shift+CmdOrCtrl+Z",
				selector: "redo:"
			},
			{
				type: "separator"
			},
			{
				label: "Cut",
				accelerator: "CmdOrCtrl+X",
				selector: "cut:"
			},
			{
				label: "Copy",
				accelerator: "CmdOrCtrl+C",
				selector: "copy:"
			},
			{
				label: "Paste",
				accelerator: "CmdOrCtrl+V",
				selector: "paste:"
			},
			{
				label: "Select All",
				accelerator: "CmdOrCtrl+A",
				selector: "selectAll:"
			}
    ]
	}
];

if (env.name !== "production") {
	mainMenu = mainMenu.concat([{
		label: "Development",
		submenu: [{
			label: "Toggle DevTools",
			accelerator: "Alt+CmdOrCtrl+I",
			click: function () {
				BrowserWindow.getFocusedWindow().toggleDevTools();
			}
        }, {
			label: "Quit",
			accelerator: "CmdOrCtrl+Q",
			click: function () {
				app.quit();
			}
        }]
	}]);
}

// =======
// LOGGING
// =======
function log(){
	console.log("[" + "DEBUG" + "][" + (new Date()).toISOString() + "] " + Array.from(arguments).map(function(x){
		if(typeof x === "object") {
			return JSON.stringify(x, null, "\t");
		} else {
			return x;
		}
	}).join(", "));
}

// =====
// MODEL
// =====

var trashFolderPath = "[Gmail]/Trash";
var allMailFolderPath = "[Gmail]/All Mail";

// how many emails should be fetched from the internet
var PEEK_NUMBER = 3;
var SUGGESTIONS_LIMIT = 10;

// Application windows
var mainWindow;
var authWindow;

// Emails
var currentEmail = {};
var cachedEmails = {};

// Oauth2
var credentials = {};

function setEmail(event, email) {
	log("SETTING EMAIL".green, email.uid, email.from, email.to, email.subject);
	currentEmail = email;
	event.sender.send("email", currentEmail);
}

function sendEmail(data, callback) {
	log("SEND EMAIL CALLED", data);

	// A load to be sent
	var load;

	var splitTo;
	var splitCc;
	
	splitTo = (data.to || "").split(",");
	splitTo.map(countEmailUse);
	
	splitCc = (data.cc || "").split(",");
	splitCc.map(countEmailUse);	

	var from = (currentEmail.from || []);

	var toWithoutMe = _.filter( // filter out self
		currentEmail.to || [],
		function(x) {
			return x.address != credentials.userId;
		}
	);

	log(from, toWithoutMe, splitTo, splitCc);

	switch(data.type) {
		case "new":
			load = {
				to: data.to,
				cc: data.cc,
				subject: data.subject,
				text: data.text,
				attachments: data.attachments
			}
			break;
		case "reply":
			load = {
				to: data.respondAll ? from.concat(toWithoutMe) : from,
				cc: data.respondAll ? splitCc : null,
				subject: data.subject,
				text: data.text
			}
			break;
		case "forward":
			load = {
				to: data.loopingIn ? from.concat(toWithoutMe).concat(splitTo) : splitTo,
				cc: data.loopingIn ? splitCc : null,
				subject: data.subject,
				text: data.text,
				attachments: currentEmail.attachments
			}
			break;
	}

	transporter.sendMail(load, callback);
}

// =======
// HELPERS
// =======
function makeQuoted(email) {
	return {
		replySubject: "Re: " + email.subject,
		forwardSubject: "Fwd: " + email.subject,
		text: "\n\n—\nSent from www.plainemail.com\n\nOn " + moment(email.date).format("LL") + ", " + email.from.map(function (x) {
			return x.name + " <" + x.address + ">"
		}).join(" ") + " wrote:\n>" + email.text.split("\n").join("\n>")
	};
}

function textToHtml(text) {
	return "<p>" + linkify(text).split(/\n+/).slice(0, 100).join("</p><p>") + "</p>";
}

// ====================
// OAUTH Authentication
// ====================
var oauth2Settings = {
	clientId: "528346688159-467v6e2br8ac3on79nfeqo3mir8m6ppj.apps.googleusercontent.com",
	clientSecret: "-VL90QUNGFX0ToI0e98BaDlO"
};

var oauth2Client = new OAuth2(oauth2Settings.clientId, oauth2Settings.clientSecret, "http://localhost");

function getOauthRedirectUrl() {
	// Scopes we want to authenticate for https://developers.google.com/gmail/api/auth/scopes
	var scopes = [
		"https://mail.google.com/", // sending & receiving
		"profile", // display name
		"email"
	];

	var url = oauth2Client.generateAuthUrl({
		scope: scopes // If you only need one scope you can pass it as string
	});

	return url;
}

function getOauthCredentials(code, callback) {
	oauth2Client.getToken(code, function (err, tokens) {
		if(err) {
			log("ERROR".red, err, tokens);
		} else {
			// Now tokens contains an access_token and an optional refresh_token. Save them.
			oauth2Client.setCredentials(tokens);

			credentials.accessToken = tokens.access_token;
			credentials.refreshToken = tokens.refresh_token;

			log("SET CREDENTIALS".green);

			// Get necessary information about the signed in user
			plus.people.get({
				userId: "me",
				auth: oauth2Client
			}, function (err, response) {
				log("RESPONSE OAUTH".green, err, response);

				credentials.displayName = response.displayName;

				// Take the email with the type "account"
				credentials.userId = _.find(response.emails, function(email) {
					return email.type === "account";
				}).value || "";

				callback(credentials);
			});
		}		
	});
}

function authenticate(callback) {
	authWindow = new BrowserWindow({
		title: "Plain Email - Authentication",
		width: 650,
		height: 800,
		show: false,
		webPreferences: {
			nodeIntegration: false
		},
		webSecurity: false
	});

	authWindow.webContents.on("did-stop-loading", function (event, oldUrl, newUrl, isMainFrame) {
		if (authWindow){
			if(authWindow.getTitle() === "Plain Email - Authentication") {				
				authWindow.close();
				log("FAILED TO LOAD AUTH WINDOW. RETRYING IN 5".red);
				setTimeout(function() {
					log("RETRYING NOW!".blue);
					authenticate(callback);
				}, 5000);
			} else {
				log("SHOWING AUTH WINDOW".green);
				authWindow.show();
			}			
		}
	});

	authWindow.webContents.on("did-get-redirect-request", function (event, oldUrl, newUrl, isMainFrame) {
		var rawCode = /code=([^&]*)/.exec(newUrl) || null;
		var code = (rawCode && rawCode.length > 1) ? rawCode[1] : null;
		var error = /\?error=(.+)$/.exec(newUrl);

		if (code || error) {
			// Close the browser if code found or error
			if (authWindow) authWindow.close();
		}

		// If there is a code in the callback, proceed to get token from google
		if (code) {
			log("GOT TOKEN FROM GOOGLE".green);

			//Attempt to fix random crashes. The theory is that the crashes happen only if google oauth client is called from within this thread
			setTimeout(function() {
				getOauthCredentials(code, callback);				
			}, 2000);
		} else if (error) {
			log("DIDN'T GET TOKEN FROM GOOGLE. RETRYING".red, error);
			authenticate(callback);
		}
	});

	authWindow.on("closed", function () {
		authWindow = null;
	});

	authWindow.loadURL(
		getOauthRedirectUrl()
	);
}

// ==============
// EMAIL HANDLING
// ==============
var imapClient;

// Send email function
var transporter;

// IDLE -> CONNECTED
var status = "IDLE";

var onceCallback; // TODO Experiment
function connect(event, callback) {
	log("CONNECT".blue);
	
	if(callback) onceCallback = _.once(callback);

	if (status === "IDLE") {
		authenticate(function () {
			// ----
			// SMTP
			// ----
			log("AUTHENTICATED".green);

			transporter = nodemailer.createTransport({
				service: "gmail",
				auth: {
					type: "OAuth2",
					user: credentials.userId,
					clientId: oauth2Settings.clientId,
			        clientSecret: oauth2Settings.clientSecret,
			        refreshToken: credentials.refreshToken,
			        accessToken: credentials.accessToken
				}
			}, {
				// default values for sendMail method
				from: credentials.displayName + " <" + credentials.userId + ">"
			});			

			// ----
			// IMAP
			// ----
			// close if anything was opened
			if(imapClient) imapClient.close();

			imapClient = new ImapClient("imap.gmail.com", 993, {
				useSecureTransport: true,
				auth: {
					user: credentials.userId,
					xoauth2: credentials.accessToken
				},
				id: {
					name: pjson.productName,
					version: pjson.version
				}
			});

			imapClient.onerror = function (err) {
				status = "IDLE";
				log("There was an error connecting to IMAP. Retrying in 5".red, err, JSON.stringify(err));
				log("RECONNECTING IN 5 SECONDS".blue);
				setTimeout(function(){
					connect(onceCallback);
				}, 5000);
			};			

			imapClient.onclose = function () {
				status = "IDLE"; // TODO could be AUTHENTICATED
				log("DISCONNECTED FROM IMAP".red, status);
				log("RECONNECTING IN 5 SECONDS".blue);
				setTimeout(function(){
					connect(onceCallback);
				}, 5000);
			};

			imapClient.connect().then(function () {
				log("CONNECTED TO IMAP".green);

				status = "CONNECTED";				

				imapClient.listMailboxes().then(function(mailboxes) {
					log("Trying to find special inboxes".blue);
					
					// identify Trash and All
					var traverse = function (mailbox) {
						if(mailbox.specialUse == "\\All") {
							log("Found All Mail Folder".blue, mailbox.path);				
							allMailFolderPath = mailbox.path;
						}

						if(mailbox.specialUse == "\\Trash") {
							log("Found Trash folder", mailbox.path);	
							trashFolderPath = mailbox.path			
						}

						if(mailbox.children) {
							mailbox.children.forEach(traverse)
						}
					}

					traverse(mailboxes)
									
					if (onceCallback) onceCallback();
				}).catch(function(err){
					log("Listing mailboxes failed".red,err);
				});				
			});
		});
	} else {		
		if (onceCallback) onceCallback();
	}
}

function parseMessage (message, callback) {
	log("PARSING MESSAGE".green, message.uid);

	simpleParser(message["body[]"], function (err, mailObject) {
		var text = mailObject.text || htmlToText.fromString(mailObject.html || "");
		var html = mailObject.html || textToHtml(mailObject.text || "");

		// Inline inline attachments
		if (mailObject.attachments) mailObject.attachments.forEach(function (attachment) {						
			if(attachment.content) {
				html = html.replace("cid:" + attachment.contentId, "data:" + attachment.contentType + ";base64," + attachment.content.toString("base64"));				
			}
		});

		var sanitizedHtml;
		try {
			sanitizedHtml = DOMPurify.sanitize(html);
		} catch(err) {
			sanitizedHtml = text;
		}

		var mail = {
			uid: message["uid"],
			from: mailObject.from ? mailObject.from.value : null,
			to: mailObject.to ? mailObject.to.value : null,
			cc: mailObject.cc ? mailObject.cc.value : null,
			date: (mailObject.date || new Date()).toISOString(),
			subject: mailObject.subject || "",
			text: text,
			html: sanitizedHtml,
			attachments: mailObject.attachments,
			unsubscribeLink: _.find(
				(mailObject.headers["list-unsubscribe"] || "").split(/[\s,<>]/),
				function(x) {
					return x.indexOf("http") == 0;
				}
			)
		};

		if(mail.from) mail.from.forEach(autocompleteAdd);
		if(mail.to) mail.to.forEach(autocompleteAdd);						
		if(mail.cc) mail.cc.forEach(autocompleteAdd);

		mail.quoted = makeQuoted(mail);

		//log("PARSED MESSAGE".yellow, mail.date, mail.subject, mail);
		callback(null, mail);
	})
}

function fetchMessages(from, to, callback) {
	imapClient.listMessages("INBOX", Math.max(from, 1) + ":" + to, ["uid", "body[]"]).then(function (messages) {
		log("FETCHED EMAILS".green);

		if (messages) {
			async.map(messages, parseMessage, function (err, emails) {
				log("UPDATED CACHE WITH THIS MANY EMAILS".green, emails.length);

				emails.forEach(function (email) {
					cachedEmails[email.uid] = email;
				});

				if (callback) callback();	
			});
		} else {
			log("AN ISSUE".red);
		}
	}).catch(function(err){
		log("Listing messages failed".red, err);		
	});
}

function updateCache(event, callback) {
	// TODO Inbox should be overridable
	imapClient.selectMailbox("INBOX", {
		readOnly: true
	}).then(function (mailboxInfo) {
		log("FETCH SEQUENCE".blue, mailboxInfo.exists - PEEK_NUMBER, mailboxInfo.exists);

		if (mailboxInfo.exists === 0) {
			log("NO EMAILS TO FETCH IT SEEMS".red);
			if (event) {
				log("SENDING INBOX ZERO".green);
				event.sender.send("zero");
			}			
		} else {			
			fetchMessages(mailboxInfo.exists - PEEK_NUMBER, mailboxInfo.exists, callback);
		}
	}).catch(function(err){
		log("Fetching mailbox failed".red, err);
		callback();
	});
}

function getLastEmail(event, callback) {
	log("GETTING LAST EMAIL".green);
	var cachedUids = Object.keys(cachedEmails);

	log("GETTING LAST EMAIL2".green, cachedUids);

	if (cachedUids.length) {
		log("CACHE FULL".red);
		// sort emails by date of receipt
		var emails = _.sortBy(cachedUids.map(function (uid) {
			return cachedEmails[uid];
		}), function (email) {
			return new Date(email.date);
		});

		callback(emails.reverse()[0]);
	} else {
		log("CACHE EMPTY".red);
		updateCache(event, function () {
			log("CACHE UPDATED".red);
			getLastEmail(event, callback);
		});
	}
}

function move(uid, folder, callback) {
	var backup = cachedEmails[uid];
	
	delete cachedEmails[uid];
	
	setTimeout(callback);

	imapClient.moveMessages("INBOX", uid, folder, {
		byUid: true
	}).then(function () {
		log("Message moved to".green, folder.green, uid);		
	}).catch(function(err){
		log("Move command failed".red, err);
		cachedEmails[uid] = backup;		
	});
}

function archive(uid, callback) {
	log("ARCHIVING MESSAGE Uid:".blue, uid);	
	move(uid, allMailFolderPath, callback);
}

function deleteMessage(uid, callback) {
	log("DELETING MESSAGE Uid:".red, uid);
	move(uid, trashFolderPath, callback);
}

// ==============
// AUTOCOMPLETION
// ==============

var userDataDirectory = jetpack.cwd(app.getPath("userData"));
var autocompleteFile = "autocomplete.json";
var autocompleteData = {
	counts: {},
	addressBook: []
};

try {
	autocompleteData = userDataDirectory.read(autocompleteFile, "json") || {
		counts: {},
		addressBook: []
	};
} catch(err) {
	log("Error reading autocomplete data");
	userDataDirectory.write(autocompleteFile, autocompleteData, { atomic: true });
}

var autocompletePersist = _.debounce(function() {
	log("PERSISTING AUTOCOMPLETE".blue);
	userDataDirectory.write(autocompleteFile, autocompleteData, { atomic: true });
}, 5000);

function countEmailUse (email) {
	autocompleteData.counts[email] = (autocompleteData.counts[email] || 0) + 1;
	autocompletePersist();
}

function autocompleteAdd(profile) {
	if(!_.find(autocompleteData.addressBook, function(x){
		return x.name == profile.name || x.address == profile.address;
	})) {
		autocompleteData.addressBook.push(profile);
	}

	autocompletePersist();
}

function autocompleteFind(query) {
	return _.uniq(_.sortBy(
		_.filter(autocompleteData.addressBook, function(x){
			return (x.name || "").toLowerCase().indexOf(query.toLowerCase()) > -1 || (x.address || "").toLowerCase().indexOf(query.toLowerCase()) > -1;
		}
	), function(profile){
		return -(autocompleteData.counts[profile.address] || 0);
	}).map(function(x) {
		return x.address
	})).slice(0, SUGGESTIONS_LIMIT);	
}

function logout() {
	log("Logging out".red);	
	if(imapClient) imapClient.close().then(function () {
		status = "IDLE";
		credentials = {};

		authWindow = new BrowserWindow({
			title: "Plain Email - Authentication",
			width: 650,
			height: 800,
			show: false,
			webPreferences: {
				nodeIntegration: false
			},
			webSecurity: false
		});

		authWindow.webContents.on("did-stop-loading", function (event, oldUrl, newUrl, isMainFrame) {
			mainWindow.webContents.reloadIgnoringCache();

			log("Logging out - success".red);
		});

		authWindow.loadURL("https://accounts.google.com/logout");
	}).catch(function(err){
		log("Logging out - failure".red, err);		
	});
}

// ==========
// CONTROLLER
// ==========
app.on("ready", function () {
	mainWindow = new BrowserWindow({
		width: 1000,
		height: 600,
		title: "Plain Email"
	});

	if (env.name === "production") {
		mainWindow.setFullScreen(true);
		mainWindow.maximize();
	}

	if (env.name === "test") {
		mainWindow.loadURL("file://" + __dirname + "/spec.html");
	} else {
		mainWindow.loadURL("file://" + __dirname + "/app.html");
	}	

	Menu.setApplicationMenu(Menu.buildFromTemplate(mainMenu));	
});

app.on("window-all-closed", function () {
	app.quit();
});

ipc.on("fetch-email", function (event) {
	connect(event, function () {
		getLastEmail(event, function (email) {
			setEmail(event, email);
		});
	});
});

ipc.on("archive", function (event, uid) {
	connect(event, function () {
		log("ARCHIVE 0".red);
		archive(currentEmail.uid, function () {
			log("ARCHIVE 1".red);
			getLastEmail(event, function (email) {
				log("ARCHIVE 2".red);
				setEmail(event, email);
			});
		});
	});
});

ipc.on("delete", function (event, uid) {
	connect(event, function () {
		deleteMessage(currentEmail.uid, function () {
			getLastEmail(event, function (email) {
				setEmail(event, email);
			});
		});
	});
});

ipc.on("send", function (event, data) {
	connect(event, function () {
		sendEmail(data, function (error, info) {
			if (error) {
				status = "IDLE";
				log("SEND FAILED".red, "Email was not send", error, info, data);
				event.sender.send("softerror", "Email was not send. Reason" + JSON.stringify(error));
			} else {
				log("SEND FINISHED".green, error, info);
				if(data.type === "new") {
					log("ASSUMING THIS WAS NEW EMAIL SEND".blue)
					getLastEmail(event, function (email) {
						setEmail(event, email);
					});
				} else {
					log("ASSUMING THIS WAS REPLY OR FORWARD. ARCHIVING...".blue)
					archive(currentEmail.uid, function () {
						getLastEmail(event, function (email) {
							setEmail(event, email);
						});
					});
				}
			}
		});
	});
});

ipc.on("autocomplete", function (event, term) {
	event.returnValue = autocompleteFind(term);
});

ipc.on("check-updates", function (event, term) {
	log("Starting to check for updates");
	setupAutoUpdater(event);
});

ipc.on("install-update", function (event, term) {
	log("Installing and updating");
	autoUpdater.quitAndInstall();	
});

ipc.on("sign-out", function (event) {	
	logout();
});