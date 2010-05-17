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
 * Portions created by the Initial Developer are Copyright (C) 2006-2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * @fileOverview Code responsible for showing and hiding object tabs.
 * This file is included from AdblockPlus.js.
 */

XPCOMUtils.defineLazyServiceGetter(this, "accessibleRetrieval", "@mozilla.org/accessibleRetrieval;1", "nsIAccessibleRetrieval");

/**
 * Class responsible for showing and hiding object tabs.
 * @class
 */
var objTabs =
{
  /**
   * Number of milliseconds to wait until hiding tab after the mouse moves away.
   * @type Integer
   */
  HIDE_DELAY: 1000,

  /**
   * Flag used to trigger object tabs initialization first time object tabs are
   * used.
   * @type Boolean
   */
  initialized: false,

  /**
   * Will be set to true while initialization is in progress.
   * @type Boolean
   */
  initializing: false,

  /**
   * Parameters for _showTab, to be called once initialization is complete.
   */
  delayedShowParams: null,

  /**
   * Randomly generated class to be used for visible object tabs on top of object.
   * @type String
   */
  objTabClassVisibleTop: null,

  /**
   * Randomly generated class to be used for visible object tabs at the bottom of the object.
   * @type String
   */
  objTabClassVisibleBottom: null,

  /**
   * Randomly generated class to be used for invisible object tabs.
   * @type String
   */
  objTabClassHidden: null,

  /**
   * Document element the object tab is currently being displayed for.
   * @type Element
   */
  currentElement: null,

  /**
   * Windows that the window event handler is currently registered for.
   * @type Array of Window
   */
  windowListeners: null,

  /**
   * Panel element currently used as object tab.
   * @type Element
   */
  objtabElement: null,

  /**
   * Time of previous position update.
   * @type Integer
   */
  prevPositionUpdate: 0,

  /**
   * Timer used to update position of the object tab.
   * @type nsITimer
   */
  positionTimer: null,

  /**
   * Timer used to delay hiding of the object tab.
   * @type nsITimer
   */
  hideTimer: null,

  /**
   * Used when hideTimer is running, time when the tab should be hidden.
   * @type Integer
   */
  hideTargetTime: 0,

  /**
   * Will be true for Gecko 1.9/1.9.1, objects occupy the entire element
   * space there including border and padding.
   * @type Boolean
   */
  get _objectOverlapsBorder()
  {
    let result = (abp.versionComparator.compare(
                        Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).platformVersion,
                        "1.9.2") < 0);
    this.__defineGetter__("_objectOverlapsBorder", function() result);
    return result;
  },

  /**
   * Initializes object tabs (generates random classes and registers stylesheet).
   */
  _initCSS: function()
  {
    this.delayedShowParams = arguments;

    if (!this.initializing)
    {
      this.initializing = true;

      function processCSSData(data)
      {
        let rnd = [];
        let offset = "a".charCodeAt(0);
        for (let i = 0; i < 60; i++)
          rnd.push(offset + Math.random() * 26);

        this.objTabClassVisibleTop = String.fromCharCode.apply(String, rnd.slice(0, 20));
        this.objTabClassVisibleBottom = String.fromCharCode.apply(String, rnd.slice(20, 40));
        this.objTabClassHidden = String.fromCharCode.apply(String, rnd.slice(40, 60));

        let url = makeURL("data:text/css," + encodeURIComponent(data.replace(/%%CLASSVISIBLETOP%%/g, this.objTabClassVisibleTop)
                                                                    .replace(/%%CLASSVISIBLEBOTTOM%%/g, this.objTabClassVisibleBottom)
                                                                    .replace(/%%CLASSHIDDEN%%/g, this.objTabClassHidden)));
        styleService.loadAndRegisterSheet(url, Ci.nsIStyleSheetService.USER_SHEET);

        this.initializing = false;
        this.initialized = true;

        if (this.delayedShowParams)
          this._showTab.apply(this, this.delayedShowParams);
      }

      // Load CSS asynchronously
      try {
        let request = new XMLHttpRequest();
        request.open("GET", "chrome://adblockplus/content/objtabs.css");
        request.overrideMimeType("text/plain");

        let me = this;
        request.onload = function()
        {
          processCSSData.call(me, request.responseText);
        }
        request.send(null);
      }
      catch (e)
      {
        Cu.reportError(e);
        this.initializing = false;
      }
    }
  },

  /**
   * Called to show object tab for an element.
   */
  showTabFor: function(/**Element*/ element)
  {
    if (!prefs.frameobjects)
      return;

    if (this.hideTimer)
    {
      this.hideTimer.cancel();
      this.hideTimer = null;
    }

    if (this.objtabElement)
      this.objtabElement.style.setProperty("opacity", "1", "important");

    if (this.currentElement != element)
    {
      this._hideTab();

      let data = RequestList.getDataForNode(element, true);
      if (data)
      {
        let doc = element.ownerDocument.defaultView
                         .QueryInterface(Ci.nsIInterfaceRequestor)
                         .getInterface(Ci.nsIWebNavigation)
                         .QueryInterface(Ci.nsIDocShellTreeItem)
                         .rootTreeItem
                         .QueryInterface(Ci.nsIInterfaceRequestor)
                         .getInterface(Ci.nsIDOMWindow)
                         .document;
        let hooks = doc.getElementById("abp-hooks");
        if (hooks && hooks.wrappedJSObject)
          hooks = hooks.wrappedJSObject;

        // Only open popup in focused window, will steal focus otherwise
        if (hooks)
        {
          if (this.initialized)
            this._showTab(hooks, element, data[1]);
          else
            this._initCSS(hooks, element, data[1]);
        }
      }
    }
  },

  /**
   * Called to hide object tab for an element (actual hiding happens delayed).
   */
  hideTabFor: function(/**Element*/ element)
  {
    if (element != this.currentElement)
      return;

    this.hideTargetTime = Date.now() + this.HIDE_DELAY;
    this.hideTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.hideTimer.init(this, 40, Ci.nsITimer.TYPE_REPEATING_SLACK);
  },

  /**
   * Makes the tab element visible.
   */
  _showTab: function(/**Element*/ hooks, /**Element*/ element, /**RequestEntry*/ data)
  {
    let doc = element.ownerDocument.defaultView.top.document;

    this.objtabElement = doc.createElementNS("http://www.w3.org/1999/xhtml", "a");
    this.objtabElement.textContent = hooks.getAttribute("objtabtext");
    this.objtabElement.setAttribute("title", hooks.getAttribute("objtabtooltip"));
    this.objtabElement.setAttribute("href", data.location);
    this.objtabElement.setAttribute("class", this.objTabClassHidden);
    this.objtabElement.style.setProperty("opacity", "1", "important");
    this.objtabElement.nodeData = data;
    hooks.initObjTab(this.objtabElement);

    this.currentElement = element;

    // Register paint listeners for the relevant windows
    this.windowListeners = [];
    let wnd = element.ownerDocument.defaultView;
    while (wnd)
    {
      wnd.addEventListener("MozAfterPaint", objectWindowEventHandler, false);
      this.windowListeners.push(wnd);
      wnd = (wnd.parent != wnd ? wnd.parent : null);
    }

    // Register mouse listeners on the object tab
    this.objtabElement.addEventListener("mouseover", objectTabEventHander, false);
    this.objtabElement.addEventListener("mouseout", objectTabEventHander, false);

    // Insert the tab into the document and adjust its position
    doc.documentElement.appendChild(this.objtabElement);
    this._positionTab();

    if (!this.positionTimer)
    {
      this.positionTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      this.positionTimer.init(this, 200, Ci.nsITimer.TYPE_REPEATING_SLACK);
    }
  },

  /**
   * Hides the tab element.
   */
  _hideTab: function()
  {
    this.delayedShowParams = null;

    if (this.objtabElement)
    {
      // Prevent recursive calls via popuphidden handler
      let objtab = this.objtabElement;
      this.objtabElement = null;
      this.currentElement = null;

      if (this.hideTimer)
      {
        this.hideTimer.cancel();
        this.hideTimer = null;
      }

      if (this.positionTimer)
      {
        this.positionTimer.cancel();
        this.positionTimer = null;
      }

      try {
        objtab.parentNode.removeChild(objtab);
      } catch (e) {}
      objtab.removeEventListener("mouseover", objectTabEventHander, false);
      objtab.removeEventListener("mouseout", objectTabEventHander, false);
      objtab.nodeData = null;

      for each (let wnd in this.windowListeners)
        wnd.removeEventListener("MozAfterPaint", objectWindowEventHandler, false);
      this.windowListeners = null;
    }
  },

  /**
   * Updates position of the tab element.
   */
  _positionTab: function()
  {
    // Test whether element is still in document
    if (!this.currentElement.offsetWidth || !this.currentElement.offsetHeight)
    {
      this._hideTab();
      return;
    }

    let objRect = this._getElementPosition(this.currentElement);

    let className = this.objTabClassVisibleTop;
    let left = objRect.right - this.objtabElement.offsetWidth;
    let top = objRect.top - this.objtabElement.offsetHeight;
    if (top < 0)
    {
      top = objRect.bottom;
      className = this.objTabClassVisibleBottom;
    }

    if (this.objtabElement.style.left != left + "px")
      this.objtabElement.style.setProperty("left", left + "px", "important");
    if (this.objtabElement.style.top != top + "px")
      this.objtabElement.style.setProperty("top", top + "px", "important");

    if (this.objtabElement.getAttribute("class") != className)
      this.objtabElement.setAttribute("class", className);

    this.prevPositionUpdate = Date.now();
  },

  /**
   * Calculates element's position relative to the top frame and considering
   * clipping due to scrolling.
   * @return {left: Number, top: Number, right: Number, bottom: Number}
   */
  _getElementPosition: function(/**Element*/ element)
  {
    // Restrict rectangle coordinates by the boundaries of a window's client area
    function intersectRect(rect, wnd)
    {
      let doc = wnd.document;
      let wndWidth = doc.documentElement.clientWidth;
      let wndHeight = doc.documentElement.clientHeight;
      if (doc.compatMode == "BackCompat") // clientHeight will be bogus in quirks mode
        wndHeight = doc.documentElement.offsetHeight - wnd.scrollMaxY;
  
      rect.left = Math.max(rect.left, 0);
      rect.top = Math.max(rect.top, 0);
      rect.right = Math.min(rect.right, wndWidth);
      rect.bottom = Math.min(rect.bottom, wndHeight);
    }

    let rect = element.getBoundingClientRect();
    let wnd = element.ownerDocument.defaultView;

    let offsets = [0, 0, 0, 0];
    if (!this._objectOverlapsBorder)
    {
      let style = wnd.getComputedStyle(element, null);
      offsets[0] = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      offsets[1] = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
      offsets[2] = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
      offsets[3] = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
    }

    rect = {left: rect.left + offsets[0], top: rect.top + offsets[1],
            right: rect.right - offsets[2], bottom: rect.bottom - offsets[3]};
    while (true)
    {
      intersectRect(rect, wnd);

      if (!wnd.frameElement)
        break;

      // Recalculate coordinates to be relative to frame's parent window
      let frameElement = wnd.frameElement;
      wnd = frameElement.ownerDocument.defaultView;

      let frameRect = frameElement.getBoundingClientRect();
      let frameStyle = wnd.getComputedStyle(frameElement, null);
      let relLeft = frameRect.left + parseFloat(frameStyle.borderLeftWidth) + parseFloat(frameStyle.paddingLeft);
      let relTop = frameRect.top + parseFloat(frameStyle.borderTopWidth) + parseFloat(frameStyle.paddingTop);

      rect.left += relLeft;
      rect.right += relLeft;
      rect.top += relTop;
      rect.bottom += relTop;
    }

    return rect;
  },

  /**
   * Called whenever a timer fires.
   */
  observe: function(/**nsISupport*/ subject, /**String*/ topic, /**String*/ data)
  {
    if (subject == this.positionTimer)
    {
      // Don't update position if it was already updated recently (via MozAfterPaint)
      if (Date.now() - this.prevPositionUpdate > 100)
        this._positionTab();
    }
    else if (subject == this.hideTimer)
    {
      let now = Date.now();
      if (now >= this.hideTargetTime)
        this._hideTab();
      else if (this.hideTargetTime - now < this.HIDE_DELAY / 2)
        this.objtabElement.style.setProperty("opacity", (this.hideTargetTime - now) * 2 / this.HIDE_DELAY, "important");
    }
  }
};

/**
 * Function called whenever the mouse enters or leaves an object.
 */
function objectMouseEventHander(/**Event*/ event)
{
  if (event.type == "mouseover")
    objTabs.showTabFor(event.target);
  else if (event.type == "mouseout")
    objTabs.hideTabFor(event.target);
}

/**
 * Function called for paint events of the object tab window.
 */
function objectWindowEventHandler(/**Event*/ event)
{
  // Don't trigger update too often, avoid overusing CPU on frequent page updates
  if (event.type == "MozAfterPaint" && Date.now() - objTabs.prevPositionUpdate > 20)
    objTabs._positionTab();
}

/**
 * Function called whenever the mouse enters or leaves an object tab.
 */
function objectTabEventHander(/**Event*/ event)
{
  if (event.type == "mouseover")
    objTabs.showTabFor(objTabs.currentElement);
  else if (event.type == "mouseout")
    objTabs.hideTabFor(objTabs.currentElement);
}

abp.objTabs = objTabs;