/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Adblock Plus.
 *
 * The Initial Developer of the Original Code is
 * Wladimir Palant.
 * Portions created by the Initial Developer are Copyright (C) 2006-2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * ***** END LICENSE BLOCK ***** */

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

var abpHideImageManager;
var RequestList = abp.RequestList;

/**
 * List of event handers to be registered. For each event handler the element ID,
 * event and the actual event handler are listed.
 * @type Array
 */
let eventHandlers = [
  ["abp-tooltip", "popupshowing", abpFillTooltip],
  ["abp-status-popup", "popupshowing", abpFillPopup],
  ["abp-toolbar-popup", "popupshowing", abpFillPopup],
  ["abp-command-settings", "command", function() { abp.openSettingsDialog(); }],
  ["abp-command-sidebar", "command", abpToggleSidebar],
  ["abp-command-togglesitewhitelist", "command", function() { toggleFilter(siteWhitelist); }],
  ["abp-command-togglepagewhitelist", "command", function() { toggleFilter(pageWhitelist); }],
  ["abp-command-toggleobjtabs", "command", function() { abpTogglePref("frameobjects"); }],
  ["abp-command-togglecollapse", "command", function() { abpTogglePref("fastcollapse"); }],
  ["abp-command-toggleshowintoolbar", "command", function() { abpTogglePref("showintoolbar"); }],
  ["abp-command-toggleshowinstatusbar", "command", function() { abpTogglePref("showinstatusbar"); }],
  ["abp-command-enable", "command", function() { abpTogglePref("enabled"); }],
  ["abp-status", "click", abpClickHandler],
  ["abp-toolbarbutton", "command", function(event) { if (event.eventPhase == event.AT_TARGET) abpCommandHandler(event); }],
  ["abp-toolbarbutton", "click", function(event) { if (event.eventPhase == event.AT_TARGET && event.button == 1) abpTogglePref("enabled"); }],
  ["abp-image-menuitem", "command", function() { abpNode(backgroundData || nodeData); }],
  ["abp-object-menuitem", "command", function() { abpNode(nodeData); }],
  ["abp-frame-menuitem", "command", function() { abpNode(frameData); }],
  ["abp-removeWhitelist-menuitem", "command", function() { removeWhitelist(); }]
];

/**
 * Stores the current value of showintoolbar preference (to detect changes).
 */
let currentlyShowingInToolbar = prefs.showintoolbar;

/**
 * Filter corresponding with "disable on site" menu item (set in abpFillPopup()).
 * @type Filter
 */
let siteWhitelist = null;
/**
 * Filter corresponding with "disable on site" menu item (set in abpFillPopup()).
 * @type Filter
 */
let pageWhitelist = null;

/**
 * Data associated with the node currently under mouse pointer (set in abpCheckContext()).
 */
let nodeData = null;
/**
 * Data associated with the background image currently under mouse pointer (set in abpCheckContext()).
 */
let backgroundData = null;
/**
 * Data associated with the frame currently under mouse pointer (set in abpCheckContext()).
 */
let frameData = null;

/**
 * Progress listener detecting location changes and triggering status updates.
 * @type nsIWebProgress
 */
let progressListener = null;

/**
 * Object implementing app-specific methods.
 */
let abpHooks = E("abp-hooks");

abpInit();

function abpInit() {
  // Initialize app hooks
  for each (let hook in ["getBrowser", "addTab", "getContextMenu", "getDefaultToolbar", "toolbarInsertBefore"])
  {
    let handler = abpHooks.getAttribute(hook);
    if (handler)
      abpHooks[hook] = new Function(handler);
  }

  // Process preferences
  window.abpDetachedSidebar = null;
  abpReloadPrefs();

  // Copy the menu from status bar icon to the toolbar
  function fixId(node)
  {
    if (node.nodeType != node.ELEMENT_NODE)
      return node;

    if ("id" in node && node.id)
      node.id = node.id.replace(/abp-status/, "abp-toolbar");

    for (var child = node.firstChild; child; child = child.nextSibling)
      fixId(child);

    return node;
  }
  function copyMenu(to)
  {
    if (!to || !to.firstChild)
      return;

    to = to.firstChild;
    var from = E("abp-status-popup");
    for (var node = from.firstChild; node; node = node.nextSibling)
      to.appendChild(fixId(node.cloneNode(true)));
  }
  let paletteButton = abpGetPaletteButton();
  copyMenu(E("abp-toolbarbutton"));
  copyMenu(paletteButton);

  // Palette button elements aren't reachable by ID, create a lookup table
  let paletteButtonIDs = {};
  if (paletteButton)
  {
    function getElementIds(element)
    {
      if (element.hasAttribute("id"))
        paletteButtonIDs[element.getAttribute("id")] = element;

      for (let child = element.firstChild; child; child = child.nextSibling)
        if (child.nodeType == Ci.nsIDOMNode.ELEMENT_NODE)
          getElementIds(child);
    }
    getElementIds(paletteButton);
  }

  // Register event listeners
  window.addEventListener("unload", abpUnload, false);
  for each (let [id, event, handler] in eventHandlers)
  {
    let element = E(id);
    if (element)
      element.addEventListener(event, handler, false);

    if (id in paletteButtonIDs)
      paletteButtonIDs[id].addEventListener(event, handler, false);
  }

  prefs.addListener(abpReloadPrefs);
  filterStorage.addFilterObserver(abpReloadPrefs);
  filterStorage.addSubscriptionObserver(abpReloadPrefs);

  let browser = abpHooks.getBrowser();
  browser.addEventListener("click", handleLinkClick, true);

  let dummy = function() {};
  let progressListener = {
    onLocationChange: abpReloadPrefs,
    onProgressChange: dummy,
    onSecurityChange: dummy,
    onStateChange: dummy,
    onStatusChange: dummy,
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener, Ci.nsISupportsWeakReference])
  };
  browser.addProgressListener(progressListener);

  // Make sure we always configure keys but don't let them break anything
  try {
    // Configure keys
    for (var key in prefs)
      if (key.match(/(.*)_key$/))
        abpConfigureKey(RegExp.$1, prefs[key]);
  } catch(e) {}

  // Install context menu handler
  var contextMenu = abpHooks.getContextMenu();
  if (contextMenu)
  {
    contextMenu.addEventListener("popupshowing", abpCheckContext, false);
  
    // Make sure our context menu items are at the bottom
    contextMenu.appendChild(E("abp-removeWhitelist-menuitem"));
    contextMenu.appendChild(E("abp-frame-menuitem"));
    contextMenu.appendChild(E("abp-object-menuitem"));
    contextMenu.appendChild(E("abp-image-menuitem"));
  }

  // First run actions
  if (!("doneFirstRunActions" in prefs) && abp.versionComparator.compare(prefs.lastVersion, "0.0") <= 0)
  {
    // Don't repeat first run actions if new window is opened
    prefs.doneFirstRunActions = true;

    // Add ABP icon to toolbar if necessary
    abp.runAsync(abpInstallInToolbar);

    // Show subscriptions dialog if the user doesn't have any subscriptions yet
    abp.runAsync(abpShowSubscriptions);
  }

  abp.runAsync(abpInitImageManagerHiding);
}

function abpUnload()
{
  prefs.removeListener(abpReloadPrefs);
  filterStorage.removeFilterObserver(abpReloadPrefs);
  filterStorage.removeSubscriptionObserver(abpReloadPrefs);
  abpHooks.getBrowser().removeProgressListener(progressListener);
}

function abpReloadPrefs() {
  var state = (prefs.enabled ? "active" : "disabled");
  var label = abp.getString("status_" + state + "_label");

  if (state == "active")
  {
    let location = getCurrentLocation();
    if (location && abp.policy.isWhitelisted(location.spec))
      state = "whitelisted";
  }

  var tooltip = E("abp-tooltip");
  if (state && tooltip)
    tooltip.setAttribute("curstate", state);

  var updateElement = function(element) {
    if (!element)
      return;

    if (element.tagName == "statusbarpanel" || element.tagName == "vbox") {
      element.hidden = !prefs.showinstatusbar;

      var labelElement = element.getElementsByTagName("label")[0];
      labelElement.setAttribute("value", label);
    }
    else
      element.hidden = !prefs.showintoolbar;

    // HACKHACK: Show status bar icon instead of toolbar icon if the application doesn't have a toolbar icon
    if (element.hidden && element.tagName == "statusbarpanel" && !abpHooks.getDefaultToolbar)
      element.hidden = !prefs.showintoolbar;

    if (currentlyShowingInToolbar != prefs.showintoolbar)
      abpInstallInToolbar();

    currentlyShowingInToolbar = prefs.showintoolbar;

    element.setAttribute("abpstate", state);
  };

  var status = E("abp-status");
  updateElement(status);
  if (prefs.defaultstatusbaraction == 0)
    status.setAttribute("popup", status.getAttribute("context"));
  else
    status.removeAttribute("popup");

  var button = E("abp-toolbarbutton");
  updateElement(button);
  if (button) {
    if (button.hasAttribute("context") && prefs.defaulttoolbaraction == 0)
    {
      button.setAttribute("popup", button.getAttribute("context"));
      button.removeAttribute("type");
    }
    else
      button.removeAttribute("popup");
  }

  updateElement(abpGetPaletteButton());
}

function abpInitImageManagerHiding() {
  if (!abp || typeof abpHideImageManager != "undefined")
    return;

  abpHideImageManager = false;
  if (prefs.hideimagemanager && "@mozilla.org/permissionmanager;1" in Cc) {
    try {
      abpHideImageManager = true;
      var permissionManager = Cc["@mozilla.org/permissionmanager;1"].getService(Ci.nsIPermissionManager);
      var enumerator = permissionManager.enumerator;
      while (abpHideImageManager && enumerator.hasMoreElements()) {
        var item = enumerator.getNext().QueryInterface(Ci.nsIPermission);
        if (item.type == "image" && item.capability == Ci.nsIPermissionManager.DENY_ACTION)
          abpHideImageManager = false;
      }
    } catch(e) {}
  }
}

function abpConfigureKey(key, value) {
  var valid = {
    accel: "accel",
    ctrl: "control",
    control: "control",
    shift: "shift",
    alt: "alt",
    meta: "meta"
  };

  var command = E("abp-command-" + key);
  if (!command)
    return;

  var parts = value.split(/\s+/);
  var modifiers = [];
  var keychar = null;
  var keycode = null;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase() in valid)
      modifiers.push(parts[i].toLowerCase());
    else if (parts[i].length == 1)
      keychar = parts[i];
    else if ("DOM_VK_" + parts[i].toUpperCase() in Ci.nsIDOMKeyEvent)
      keycode = "VK_" + parts[i].toUpperCase();
  }

  if (keychar || keycode) {
    var element = document.createElement("key");
    element.setAttribute("id", "abp-key-" + key);
    element.setAttribute("command", "abp-command-" + key);
    if (keychar)
      element.setAttribute("key", keychar);
    else
      element.setAttribute("keycode", keycode);
    element.setAttribute("modifiers", modifiers.join(","));

    E("abp-keyset").appendChild(element);
  }
}

/**
 * Handles browser clicks to intercept clicks on abp: links.
 */
function handleLinkClick(/**Event*/ event)
{
  // Ignore right-clicks
  if (event.button == 2)
    return;

  let link = event.target;
  while (link && !(link instanceof Ci.nsIDOMNSHTMLAnchorElement))
    link = link.parentNode;

  if (link && /^abp:\/*subscribe\/*\?(.*)/i.test(link.href))
  {
    event.preventDefault();
    event.stopPropagation();

    let unescape = Cc["@mozilla.org/intl/texttosuburi;1"].getService(Ci.nsITextToSubURI);

    let params = RegExp.$1.split('&');
    let title = null;
    let url = null;
    for each (let param in params)
    {
      let parts = param.split("=", 2);
      if (parts.length == 2 && parts[0] == 'title')
        title = decodeURIComponent(parts[1]);
      if (parts.length == 2 && parts[0] == 'location')
        url = decodeURIComponent(parts[1]);
    }

    if (url && /\S/.test(url))
    {
      if (!title || !/\S/.test(title))
        title = url;

      var subscription = {url: url, title: title, disabled: false, external: false, autoDownload: true};

      window.openDialog("chrome://adblockplus/content/ui/subscription.xul", "_blank",
                         "chrome,centerscreen,modal", subscription);
    }
  }
}

// Finds the toolbar button in the toolbar palette
function abpGetPaletteButton() {
  var toolbox = E("navigator-toolbox") || E("mail-toolbox");
  if (!toolbox || !("palette" in toolbox) || !toolbox.palette)
    return null;

  for (var child = toolbox.palette.firstChild; child; child = child.nextSibling)
    if (child.id == "abp-toolbarbutton")
      return child;

  return null;
}

// Check whether we installed the toolbar button already
function abpInstallInToolbar()
{
  let tb = E("abp-toolbarbutton");
  if (!tb || tb.parentNode.localName == "toolbarpalette")
  {
    let toolbar = (abpHooks.getDefaultToolbar ? abpHooks.getDefaultToolbar() : null);
    let insertBefore = (abpHooks.toolbarInsertBefore ? abpHooks.toolbarInsertBefore() : null);
    if (toolbar && "insertItem" in toolbar)
    {
      if (insertBefore && insertBefore.parentNode != toolbar)
        insertBefore = null;

      toolbar.insertItem("abp-toolbarbutton", insertBefore, null, false);

      toolbar.setAttribute("currentset", toolbar.currentSet);
      document.persist(toolbar.id, "currentset");

      // HACKHACK: Make sure icon is added to both main window and message window in Thunderbird
      var override = null;
      if (window.location.href == "chrome://messenger/content/messenger.xul")
        override = "chrome://messenger/content/messageWindow.xul#mail-bar";
      else if (window.location.href == "chrome://messenger/content/messageWindow.xul")
        override = "chrome://messenger/content/messenger.xul#mail-bar";

      if (override) {
        try {
          var rdf = Cc["@mozilla.org/rdf/rdf-service;1"].getService(Ci.nsIRDFService);
          var localstore = rdf.GetDataSource("rdf:local-store");
          var resource = rdf.GetResource(override);
          var arc = rdf.GetResource("currentset");
          var target = localstore.GetTarget(resource, arc, true);
          var currentSet = (target ? target.QueryInterface(Ci.nsIRDFLiteral).Value : E('mail-bar').getAttribute("defaultset"));

          if (/\bbutton-junk\b/.test(currentSet))
            currentSet = currentSet.replace(/\bbutton-junk\b/, "abp-toolbarbutton,button-junk");
          else
            currentSet = currentSet + ",abp-toolbarbutton";

          if (target)
            localstore.Unassert(resource, arc, target, true);
          localstore.Assert(resource, arc, rdf.GetLiteral(currentSet), true);
        } catch (e) {}
      }
    }
  }
}

// Let user choose subscriptions on first start unless he has some already
function abpShowSubscriptions()
{
  // Look for existing subscriptions
  for each (let subscription in filterStorage.subscriptions)
    if (subscription instanceof abp.DownloadableSubscription)
      return;

  let browser = abpHooks.getBrowser();
  if ("addTab" in browser)
  {
    // We have a tabbrowser
    browser.selectedTab = browser.addTab("chrome://adblockplus/content/ui/tip_subscriptions.xul");
  }
  else
  {
    window.openDialog("chrome://adblockplus/content/ui/tip_subscriptions.xul", "_blank", "chrome,centerscreen,resizable,dialog=no");
  }
}

function abpFillTooltip(event) {
  if (!document.tooltipNode || !document.tooltipNode.hasAttribute("tooltip"))
  {
    event.preventDefault();
    return;
  }

  var type = (document.tooltipNode && document.tooltipNode.id == "abp-toolbarbutton" ? "toolbar" : "statusbar");
  var action = parseInt(prefs["default" + type + "action"]);
  if (isNaN(action))
    action = -1;

  var actionDescr = E("abp-tooltip-action");
  actionDescr.hidden = (action < 0 || action > 3);
  if (!actionDescr.hidden)
    actionDescr.setAttribute("value", abp.getString("action" + action + "_tooltip"));

  var state = event.target.getAttribute("curstate");
  var statusDescr = E("abp-tooltip-status");
  statusDescr.setAttribute("value", abp.getString(state + "_tooltip"));

  var activeFilters = [];
  E("abp-tooltip-blocked-label").hidden = (state != "active");
  E("abp-tooltip-blocked").hidden = (state != "active");
  if (state == "active") {
    var data = RequestList.getDataForWindow(abpHooks.getBrowser().contentWindow);
    var locations = data.getAllLocations();

    var blocked = 0;
    var filterCount = {__proto__: null};
    for (i = 0; i < locations.length; i++) {
      if (locations[i].filter && !(locations[i].filter instanceof abp.WhitelistFilter))
        blocked++;
      if (locations[i].filter) {
        if (locations[i].filter.text in filterCount)
          filterCount[locations[i].filter.text]++;
        else
          filterCount[locations[i].filter.text] = 1;
      }
    }

    var blockedStr = abp.getString("blocked_count_tooltip");
    blockedStr = blockedStr.replace(/--/, blocked).replace(/--/, locations.length);
    E("abp-tooltip-blocked").setAttribute("value", blockedStr);

    var filterSort = function(a, b) {
      return filterCount[b] - filterCount[a];
    };
    for (var filter in filterCount)
      activeFilters.push(filter);
    activeFilters = activeFilters.sort(filterSort);
  }

  E("abp-tooltip-filters-label").hidden = (activeFilters.length == 0);
  E("abp-tooltip-filters").hidden = (activeFilters.length == 0);
  if (activeFilters.length > 0) {
    var filtersContainer = E("abp-tooltip-filters");
    while (filtersContainer.firstChild)
      filtersContainer.removeChild(filtersContainer.firstChild);

    for (var i = 0; i < activeFilters.length && i < 3; i++) {
      var descr = document.createElement("description");
      descr.setAttribute("value", activeFilters[i] + " (" + filterCount[activeFilters[i]] + ")");
      filtersContainer.appendChild(descr);
    }
    if (activeFilters.length > 3) {
      var descr = document.createElement("description");
      descr.setAttribute("value", "...");
      filtersContainer.appendChild(descr);
    }
  }
}

/**
 * Retrieves the current location of the browser (might return null on failure).
 */
function getCurrentLocation() /**nsIURI*/
{
  if ("currentHeaderData" in window && "content-base" in window.currentHeaderData)
  {
    // Thunderbird blog entry
    return abp.unwrapURL(window.currentHeaderData["content-base"].headerValue);
  }
  else if ("currentHeaderData" in window && "from" in window.currentHeaderData)
  {
    // Thunderbird mail/newsgroup entry
    try
    {
      let headerParser = Cc["@mozilla.org/messenger/headerparser;1"].getService(Ci.nsIMsgHeaderParser);
      let emailAddress = headerParser.extractHeaderAddressMailboxes(window.currentHeaderData.from.headerValue);
      return abp.makeURL("mailto:" + emailAddress.replace(/^[\s"]+/, "").replace(/[\s"]+$/, "").replace(/\s/g, "%20"));
    }
    catch(e)
    {
      return null;
    }
  }
  else
  {
    // Regular browser
    return abp.unwrapURL(abpHooks.getBrowser().contentWindow.location.href);
  }
}

// Fills the context menu on the status bar
function abpFillPopup(event) {
  let popup = event.target;

  // Not at-target call, ignore
  if (popup.getAttribute("id").indexOf("options") >= 0)
    return;

  // Need to do it this way to prevent a Gecko bug from striking
  var elements = {};
  var list = popup.getElementsByTagName("menuitem");
  for (var i = 0; i < list.length; i++)
    if (list[i].id && /\-(\w+)$/.test(list[i].id))
      elements[RegExp.$1] = list[i];

  var sidebarOpen = abpIsSidebarOpen();
  elements.opensidebar.hidden = sidebarOpen;
  elements.closesidebar.hidden = !sidebarOpen;

  var whitelistItemSite = elements.whitelistsite;
  var whitelistItemPage = elements.whitelistpage;
  whitelistItemSite.hidden = whitelistItemPage.hidden = true;

  var whitelistSeparator = whitelistItemPage.nextSibling;
  while (whitelistSeparator.nodeType != whitelistSeparator.ELEMENT_NODE)
    whitelistSeparator = whitelistSeparator.nextSibling;

  let location = getCurrentLocation();
  if (location && abp.policy.isBlockableScheme(location))
  {
    let host = null;
    try
    {
      host = location.host.replace(/^www\./, "");
    } catch (e) {}

    if (host)
    {
      let ending = "|";
      if (location instanceof Ci.nsIURL && location.ref)
        location.ref = "";
      if (location instanceof Ci.nsIURL && location.query)
      {
        location.query = "";
        ending = "?";
      }

      siteWhitelist = abp.Filter.fromText("@@||" + host + "^$document");
      whitelistItemSite.setAttribute("checked", siteWhitelist.subscriptions.length && !siteWhitelist.disabled);
      whitelistItemSite.setAttribute("label", whitelistItemSite.getAttribute("labeltempl").replace(/--/, host));
      whitelistItemSite.hidden = false;

      pageWhitelist = abp.Filter.fromText("@@|" + location.spec + ending + "$document");
      whitelistItemPage.setAttribute("checked", pageWhitelist.subscriptions.length && !pageWhitelist.disabled);
      whitelistItemPage.hidden = false;
    }
    else
    {
      siteWhitelist = abp.Filter.fromText("@@|" + location.spec + "|");
      whitelistItemSite.setAttribute("checked", siteWhitelist.subscriptions.length && !siteWhitelist.disabled);
      whitelistItemSite.setAttribute("label", whitelistItemSite.getAttribute("labeltempl").replace(/--/, location.spec.replace(/^mailto:/, "")));
      whitelistItemSite.hidden = false;
    }
  }
  whitelistSeparator.hidden = whitelistItemSite.hidden && whitelistItemPage.hidden;

  elements.enabled.setAttribute("checked", prefs.enabled);
  elements.frameobjects.setAttribute("checked", prefs.frameobjects);
  elements.slowcollapse.setAttribute("checked", !prefs.fastcollapse);
  elements.showintoolbar.setAttribute("checked", prefs.showintoolbar);
  elements.showinstatusbar.setAttribute("checked", prefs.showinstatusbar);

  var defAction = (popup.tagName == "menupopup" || document.popupNode.id == "abp-toolbarbutton" ? prefs.defaulttoolbaraction : prefs.defaultstatusbaraction);
  elements.opensidebar.setAttribute("default", defAction == 1);
  elements.closesidebar.setAttribute("default", defAction == 1);
  elements.settings.setAttribute("default", defAction == 2);
  elements.enabled.setAttribute("default", defAction == 3);
}

function abpIsSidebarOpen() {
  // Test whether detached sidebar window is open
  if (window.abpDetachedSidebar && !window.abpDetachedSidebar.closed)
    return true;

  var sidebar = E("abp-sidebar");
  return (sidebar ? !sidebar.hidden : false);
}

function abpToggleSidebar() {
  if (window.abpDetachedSidebar && !window.abpDetachedSidebar.closed)
    window.abpDetachedSidebar.close();
  else {
    var sidebar = E("abp-sidebar");
    if (sidebar && (!prefs.detachsidebar || !sidebar.hidden)) {
      E("abp-sidebar-splitter").hidden = !sidebar.hidden;
      E("abp-sidebar-browser").setAttribute("src", sidebar.hidden ? "chrome://adblockplus/content/ui/sidebar.xul" : "about:blank");
      sidebar.hidden = !sidebar.hidden;
      if (sidebar.hidden)
        abpHooks.getBrowser().contentWindow.focus();
    }
    else
      window.abpDetachedSidebar = window.openDialog("chrome://adblockplus/content/ui/sidebarDetached.xul", "_blank", "chrome,resizable,dependent,dialog=no,width=600,height=300");
  }

  let menuItem = E("abp-blockableitems");
  if (menuItem)
    menuItem.setAttribute("checked", abpIsSidebarOpen());
}

// Toggles the value of a boolean pref
function abpTogglePref(pref) {
  prefs[pref] = !prefs[pref];
  prefs.save();
}

/**
 * If the given filter is already in user's list, removes it from the list. Otherwise adds it.
 */
function toggleFilter(/**Filter*/ filter)
{
  if (filter.subscriptions.length)
  {
    if (filter.disabled || filter.subscriptions.some(function(subscription) !(subscription instanceof abp.SpecialSubscription)))
    {
      filter.disabled = !filter.disabled;
      filterStorage.triggerFilterObservers(filter.disabled ? "disable" : "enable", [filter]);
    }
    else
      filterStorage.removeFilter(filter);
  }
  else
    filterStorage.addFilter(filter);
  filterStorage.saveToDisk();
}

/**
 * Removes/disable the exception rule applying for the current page.
 */
function removeWhitelist()
{
  let location = getCurrentLocation();
  let filter = null;
  if (location)
    filter = abp.policy.isWhitelisted(location.spec);
  if (filter && filter.subscriptions.length && !filter.disabled)
    toggleFilter(filter);
}

// Handle clicks on the Adblock statusbar panel
function abpClickHandler(e) {
  if (e.button == 0)
    abpExecuteAction(prefs.defaultstatusbaraction);
  else if (e.button == 1)
    abpTogglePref("enabled");
}

function abpCommandHandler(e) {
  if (prefs.defaulttoolbaraction == 0)
    e.target.open = true;
  else
    abpExecuteAction(prefs.defaulttoolbaraction);
}

// Executes default action for statusbar/toolbar by its number
function abpExecuteAction(action) {
  if (action == 1)
    abpToggleSidebar();
  else if (action == 2)
    abp.openSettingsDialog();
  else if (action == 3)
    abpTogglePref("enabled");
}

// Retrieves the image URL for the specified style property
function abpImageStyle(computedStyle, property) {
  var value = computedStyle.getPropertyCSSValue(property);
  if (value instanceof Ci.nsIDOMCSSValueList && value.length >= 1)
    value = value[0];
  if (value instanceof Ci.nsIDOMCSSPrimitiveValue && value.primitiveType == Ci.nsIDOMCSSPrimitiveValue.CSS_URI)
    return abp.unwrapURL(value.getStringValue()).spec;

  return null;
}

// Hides the unnecessary context menu items on display
function abpCheckContext() {
  var contextMenu = abpHooks.getContextMenu();
  var target = document.popupNode;

  var nodeType = null;
  backgroundData = null;
  frameData = null;
  if (target) {
    // Lookup the node in our stored data
    var data = RequestList.getDataForNode(target);
    var targetNode = null;
    if (data) {
      targetNode = data[0];
      data = data[1];
    }
    nodeData = data;
    if (data && !data.filter)
      nodeType = data.typeDescr;

    var wnd = (target ? target.ownerDocument.defaultView : null);
    var wndData = (wnd ? RequestList.getDataForWindow(wnd) : null);

    if (wnd.frameElement)
      frameData = RequestList.getDataForNode(wnd.frameElement, true);
    if (frameData)
      frameData = frameData[1];
    if (frameData && frameData.filter)
      frameData = null;

    if (nodeType != "IMAGE") {
      // Look for a background image
      var imageNode = target;
      while (imageNode && !backgroundData) {
        if (imageNode.nodeType == imageNode.ELEMENT_NODE) {
          var bgImage = null;
          var style = wnd.getComputedStyle(imageNode, "");
          bgImage = abpImageStyle(style, "background-image") || abpImageStyle(style, "list-style-image");
          if (bgImage) {
            backgroundData = wndData.getLocation(abp.policy.type.BACKGROUND, bgImage);
            if (backgroundData && backgroundData.filter)
              backgroundData = null;
          }
        }

        imageNode = imageNode.parentNode;
      }
    }

    // Hide "Block Images from ..." if hideimagemanager pref is true and the image manager isn't already blocking something
    var imgManagerContext = E("context-blockimage");
    if (imgManagerContext) {
      if (typeof abpHideImageManager == "undefined")
        abpInitImageManagerHiding();

      // Don't use "hidden" attribute - it might be overridden by the default popupshowing handler
      imgManagerContext.style.display = (abpHideImageManager ? "none" : "");
    }
  }

  E("abp-image-menuitem").hidden = (nodeType != "IMAGE" && backgroundData == null);
  E("abp-object-menuitem").hidden = (nodeType != "OBJECT");
  E("abp-frame-menuitem").hidden = (frameData == null);

  let location = getCurrentLocation();
  E("abp-removeWhitelist-menuitem").hidden = (!location || !abp.policy.isWhitelisted(location.spec));
}

// Bring up the settings dialog for the node the context menu was referring to
function abpNode(data) {
  if (data)
    window.openDialog("chrome://adblockplus/content/ui/composer.xul", "_blank", "chrome,centerscreen,resizable,dialog=no,dependent", abpHooks.getBrowser().contentWindow, data);
}
