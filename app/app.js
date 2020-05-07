"use strict";

// =======
// MODULES
// =======

// Electron core modules
var electron = require("electron");
var ipc = electron.ipcRenderer;
var webFrame = electron.webFrame;
var shell = electron.shell;

var remote = electron.remote;
var BrowserWindow = remote.BrowserWindow;

// Utilities
var os = require("os");
var path = require("path");
var app = remote.app;
var jetpack = require("fs-jetpack").cwd(app.getAppPath());
var moment = require("moment");
var filesize = require("filesize");

// jQuery
window.$ = window.jQuery = require("jquery");
require("jquery-ui");

$.fn.switchUiState = function(state) {
    this.removeClass("reading loading zero responding delegating composing").addClass(state)
    $(".email").scrollTop(0);
    return this;
};

// ========
// UPDATING
// ========
$(function(){
	$(".js-update").hide().click(function(){
		ipc.send("install-update");
	});

	ipc.on("update-available", function (event, error) {
		$(".js-update").show();	
	});

	ipc.send("check-updates");	
});

// ===========
// FILE UPLOAD
// ===========
$(function(){
	var handler = $(".plain-email");

	var preventer = function(event){
		event.preventDefault();
		event.stopPropagation();
	};

	handler.on("dragenter dragover dragleave", preventer);

	handler[0].ondrop = function(event){
		event.preventDefault();
		event.stopPropagation();		

		var files = event.dataTransfer.files;
		for(var i = 0; i<files.length; i++) {			
			var parsedPath = path.parse(files[i].path);
			
			$(".composing-column .attachments").append(
				$("<div></div>").html(
					$("<a class='attachment'></a>")
						.text("Attachment: " + parsedPath.base)
						.attr("data-filename", parsedPath.base)
						.attr("data-path", files[i].path)
				)
			);
		}		
	};
});

// =============
// SPELLCHECKING
// =============

var selection;

function resetSelection() {
	selection = {
		isMisspelled: false,
		spellingSuggestions: []
	};
}

resetSelection();

// Reset the selection when clicking around, before the spell-checker runs and the context menu shows.
window.addEventListener("mousedown", resetSelection);

// =======
// COOKIES
// =======

document.__defineGetter__("cookie", function () {
	var cookies = JSON.parse(localStorage.cookies || "{}");

	var output = [];
	for (var cookieName in cookies) {
	  output.push(cookieName + "=" + cookies[cookieName]);
	}
	return output.join(";");
});

document.__defineSetter__("cookie", function (s) {
	var cookies = JSON.parse(localStorage.cookies || "{}");

	var parts = s.split("=");
	var key = parts[0];
	var value = parts[1];
	
	cookies[key] = value;

	localStorage.cookies = JSON.stringify(cookies);
	return key + "=" + value;
});

document.clearCookies = function () {
	return delete localStorage.cookies;
};

// ================
// GOOGLE ANALYTICS
// ================

(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){
(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),
m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)
})(window,document,'script','https://www.google-analytics.com/analytics.js','ga');
                
ga("create", "UA-72649000-2", "none");
ga("set", "checkProtocolTask", function(){});
ga("set", "location", "http://www.plainemail.com");
ga("send", "pageview");

// ==========
// CONTROLLER
// ==========

function fetchEmail() {	
	$(".plain-email").switchUiState("loading");	
	ipc.send("fetch-email");
}

function archive() {	
	$(".plain-email").switchUiState("loading");
	ipc.send("archive");
}

function startResponding(justSender) {
	$(".plain-email").switchUiState("responding");
	$(".responding-column .body-write-box")[0].setSelectionRange(0, 0);
	$(".responding-column .body-write-box").focus();
	$(".js-respond-checkbox").prop("checked", justSender);
}

function startComposing() {
	$(".plain-email").switchUiState("composing");
	$(".composing-column .subject-write-box").focus();
}

function startDelegating(loopingIn) {
	$(".plain-email").switchUiState("delegating");
	$(".delegating-column .tagit input").first().focus();
	$(".js-loop-in-checkbox").prop("checked", loopingIn);
}

function deleteEmail() {
	if (confirm("Really delete?")) {
		$(".plain-email").switchUiState("loading");
		ipc.send("delete");
	}
}

function delegateSend() {	
	$(".plain-email").switchUiState("loading");
	
	ipc.send("send", {
		type: "forward",
		to: $(".delegating-column .recipients").val(),
		cc: $(".delegating-column .carbon-copy-recipients").val(),
		subject: $(".delegating-column .subject-write-box").val(),
		text: $(".delegating-column .body-write-box").val(),
		loopingIn: $(".js-loop-in-checkbox").is(":checked")
	});
}

function responseSend() {
	$(".plain-email").switchUiState("loading");

	ipc.send("send", {
		type: "reply",
		subject: $(".responding-column .subject-write-box").val(),
		text: $(".responding-column .body-write-box").val(),
		respondAll: $(".js-respond-checkbox").is(":checked")
	});
}

function signOut() {
	$(".plain-email").switchUiState("loading");
		
	ipc.send("sign-out");
}

function composeSend() {
	$(".plain-email").switchUiState("loading");

	ipc.send("send", {
		type: "new",
		to: $(".composing-column .recipients").val(),
		cc: $(".composing-column .carbon-copy-recipients").val(),
		subject: $(".composing-column .subject-write-box").val(),
		text: $(".composing-column .body-write-box").val(),
		attachments: $(".composing-column .attachments .attachment").map(function(index, element) {			
			return {
				filename: $(element).attr("data-filename"),
				path: $(element).attr("data-path")
			};
		}).toArray()
	});
}

// ===============
// KEYBOARD EVENTS
// ===============

function keyupHandler(event) {
	$(".plain-email").removeClass("keyboard-modifier");
}

// handle when cmd+tab is pressed and the key up event is skipped
$(window).blur(keyupHandler).focus(keyupHandler);

function keydownHandler(event) {
	if ((event.metaKey || event.ctrlKey) && (event.keyCode == 17 || event.keyCode == 91) ) {
		$(".plain-email").addClass("keyboard-modifier");
	}

	if (event.keyCode == 27) {
		$(".js-start-reading:visible").click();
	}

	if ((event.metaKey || event.ctrlKey) && event.keyCode == 13) {
		$(".primary.button:visible").click();
	}

	if ((event.metaKey || event.ctrlKey) && event.keyCode == 78) {
		$(".js-compose:visible").click();
	}

	if (event.target.tagName.toLowerCase() === "input" || event.target.tagName.toLowerCase() === "textarea") {
		return;
	}

	if (event.which == 32) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();
		$(".js-first:visible").click();
	}

	if (event.which == 37) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();
		$(".js-second:visible").click()
	}

	if (event.which == 39) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();
		$(".js-third:visible").click()
	}

	if (event.which == 38) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();
		$(".js-fourth:visible").click()
	}

	if (event.which == 85) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();
		$(".js-unsubscribe:visible").click();
	}

	if (event.which == 8) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();
		$(".js-delete:visible").click();
	}

	if (event.which == 192) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();
		
		if (env.name !== "production") {
			remote.getCurrentWindow().toggleDevTools();
		}
	}

	if (event.which == 72) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();
		
		$("header").css("visibility","hidden");
		$("footer").css("visibility","hidden");
	}

	if ((event.metaKey || event.ctrlKey) && event.which == 76) {
		event.preventDefault(); // prevent the default action (scroll / move caret)
		event.stopPropagation();

		signOut();	
	}
}

// ============
// MOUSE EVENTS
// ============

$(function () {
	// Prevent opening new Electron window on cmd+click
	$(".action, .js-compose").click(function (event) {
		if (event.metaKey || event.ctrlKey) {
	        event.preventDefault();
		}
	})


	$(".js-get-email").click(function () {
		fetchEmail();
	});

	$(".js-archive").click(function () {
		archive();
	});

	$(".js-respond-all").click(function () {
		startResponding(true);
	});

	$(".js-delegate").click(function () {
		startDelegating(false);
	});

	$(".js-delegate-send").click(function () {
		delegateSend();
	});

	$(".js-compose-send").click(function () {
		composeSend();
	});

	$(".js-response-send").click(function () {
		responseSend();
	});

	$(".js-start-reading").click(function () {
		fetchEmail();
	});

	$(".js-compose").click(function () {
		startComposing();
	});

	$(".js-delete").click(function () {
		deleteEmail();
	});

	$(".js-loop-in").click(function () {
		startDelegating(true);
	});

	$(".js-respond").click(function () {
		startResponding(false);
	});
});

// ====
// VIEW
// ====

// Initialize UI
$(function () {
	fetchEmail();

	$("body").keydown(keydownHandler).keyup(keyupHandler);

	$(".recipients").tagit({
		placeholderText: "to",
		animate: false,
		autocomplete: {
			source: function (request, response) {
				response(
					ipc.sendSync("autocomplete", request.term)
				);
			}
		}
	});

	$(".carbon-copy-recipients").tagit({
		placeholderText: "cc",
		animate: false,
		autocomplete: {
			source: function (request, response) {
				response(
					ipc.sendSync("autocomplete", request.term)
				);
			}
		}
	});

	var messages = [
		"Get back to work now.",
		"What a ride!",
		"Go and live your life now.",
		"You're getting faster!",
		"I think this was a record time.",
		"More email coming soon!",
		"What? That was it?",
		"Void.",
		"Emails are no more.",
		"I knew you could do it!",
		"That was easy, right?",
		"Another job well done.",
		"Calling it a success!",
		"Our work is done here.",
		"I knew it was possible!",
		"I checked, and it is true!",
		"Nailed it!",
		"Hasta la vista, baby.",
		"See You Later, Alligator.",
		"Veni, vidi, vici.",
		"you have reached, young padawan.",
		"Energy levels over 9000!",
		"Move along, nothing to see here.",
		"You're my hero, inbox zero!"
	];

	$(".zero-quote").text(
		messages[Math.floor(
			Math.random() * messages.length
		)]
	);
});


function buildEntityList(selector, data) {
	if (data) data.forEach(function (x) {
		return $(selector).append(
			$("<a></a>")
				.text(x.name == "" ? x.address : x.name + " ")
				.addClass("hint--bottom-right hint--no-animate")
				.attr("data-hint", x.address)
		)
	});
}

ipc.on("email", function (event, email) {
	// Clean up UI
	$(".delegating-column .recipients").tagit("removeAll");
	$(".delegating-column .carbon-copy-recipients").tagit("removeAll");
	
	$(".composing-column .recipients").tagit("removeAll");
	$(".composing-column .carbon-copy-recipients").tagit("removeAll");
	$(".composing-column .subject-write-box").val("");
	$(".composing-column .body-write-box").val("");
	$(".composing-column .attachments").html("");

	// Build UI for the received email
	$(".from").html("");
	buildEntityList(".from", email.from);

	$(".to").html("");
	buildEntityList(".to", email.to);
	buildEntityList(".to", email.cc);

	var $attachments = $(".email-column .attachments, .delegating-column .attachments");
	$attachments.html("");
	if (email.attachments) email.attachments.forEach(function (attachment) {
		console.log(attachment);

		if((attachment.contentDisposition == "attachment" || (attachment.contentType && !attachment.contentType.startsWith("image"))) && attachment.content) {
			var base64encodedImage = "data:application/octet-stream;base64," + attachment.content.toString("base64");

			var $attachmentLink = $("<a></a>")
				.text("Attachment: " + attachment.filename + " (" + filesize(attachment.size)+ ")")
				.addClass("attachment")
				.attr("download", attachment.filename)
				.attr("href", base64encodedImage);
			
			// Lightbox if the content is an image
			if(attachment.contentType.startsWith("image")) $($attachmentLink).magnificPopup({
				type: "image",
				image: {
					markup: '<div class="mfp-figure">'+
						'<div class="mfp-close"></div>'+
						'<figure>'+
							'<a href="'+base64encodedImage+'" download="'+attachment.filename+'"><div class="mfp-img"></div></a>'+
							'<figcaption>' +
								'<div class="mfp-bottom-bar">'+
									'<div class="mfp-title"></div>'+
									'<div class="mfp-counter"></div>'+
								'</div>'+
							'</figcaption>'+
						'</figure>'+
					'</div>'
				}
			});

			$attachments.append($("<div></div>").html($attachmentLink));
		}
	});

	$(".subject")
		.text(email.subject);

	$(".date")
		.text(
			moment(email.date).from(moment())
		).attr("title", moment(email.date).calendar());
	
	// Render email body
	$(".body").html($("<iframe></iframe>"));

	var $frame = $(".body iframe");

	var doc = $frame[0].contentWindow.document;

	var $head = $("head", doc);

	$head.append($("<link/>", {
		rel: "stylesheet",
		href: "./stylesheets/main.css",
		type: "text/css"
	}));	

	var $body = $("body", doc);
	$body.html(email.html);

	$("a", $body).click(function (event) {
		event.preventDefault();		
		shell.openExternal($(this).attr("href"));
	});

	// Set unsubscribe link
	$(".js-respond-all").removeClass("hidden");
	$(".js-unsubscribe").addClass("hidden").unbind("click");
	
	function setUnsubscribeLink (url) {
		$(".js-respond-all").addClass("hidden");

		$(".js-unsubscribe").removeClass("hidden").unbind("click").click(function () {
			if (confirm("Unsubscribe?")) {
				shell.openExternal(url);
			}
		});
	}

	if(email.unsubscribeLink) {
		setUnsubscribeLink(email.unsubscribeLink);
	} else {
		$("a", $body).each(function (index, link) {
			var linkUrl = $(link).attr("href") || "";
			var linkText = ($(link).text() || "").toLowerCase();

			if (
				linkUrl.indexOf("http://www.aweber.com/z/r/?") > -1 ||
				linkText.indexOf("unsubscribe") > -1 ||
				linkText.indexOf("opt out") > -1 ||
				linkText.indexOf("opt-out") > -1 ||
				linkText.indexOf("change email preferences") > -1
			) {
				setUnsubscribeLink(linkUrl);
			}
		});
	}	

	// Reset keyboard handler
	$body.unbind("keydown").keydown(keydownHandler);
	$body.unbind("keyup").keyup(keyupHandler);

	// Resize iframe to match the content
	var updateBody = function () {
		var body = doc.body;
		var html = doc.documentElement;

		$frame.css({
			height: Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight)
		});
	}

	// haha, progressive enhancement as the iframe loads. I really tried to make this prettier!
	var times = [100, 1000, 2000, 3000, 5000];

	times.map(function(time){
		setTimeout(updateBody, time);	
	});
	
	// Reply & delegate
	$(".responding-column .subject-write-box").text(email.quoted.replySubject);
	$(".delegating-column .subject-write-box").text(email.quoted.forwardSubject);
	$(".quoted-body").val(email.quoted.text);

	// Display UI
	$(".plain-email").switchUiState("reading");
});

ipc.on("error", function (event, error) {
	$(".plain-email").switchUiState("loading");
	location.reload();
});

ipc.on("softerror",function (event, error) {
	$(".plain-email").switchUiState("reading");
	alert(error);
});

ipc.on("loading", function (event) {
	$(".plain-email").switchUiState("loading");
});

ipc.on("zero", function (event) {
	$(".plain-email").switchUiState("zero");
});