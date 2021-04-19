import {Logger} from "./logging";
import Year from "./year";
import Month from "./month";
import {Note} from "./note";
import {CalendarTemplate, NoteTemplate, SimpleCalendarSocket} from "../interfaces";
import {SimpleCalendarConfiguration} from "./simple-calendar-configuration";
import {GameSettings} from "./game-settings";
import {Weekday} from "./weekday";
import {SimpleCalendarNotes} from "./simple-calendar-notes";
import HandlebarsHelpers from "./handlebars-helpers";
import {GameWorldTimeIntegrations, ModuleSocketName, SocketTypes} from "../constants";
import Importer from "./importer";
import Season from "./season";
import Moon from "./moon";


/**
 * Contains all functionality for displaying/updating the simple calendar
 */
export default class SimpleCalendar extends Application{

    /**
     * Used to store a globally accessible copy of the Simple calendar class for access from event functions.
     */
    static instance: SimpleCalendar;

    /**
     * The current year the user is viewing
     * @type {Year | null}
     */
    public currentYear: Year | null = null;

    /**
     * List of all notes in the calendar
     * @type {Array.<Note>}
     */
    public notes: Note[] = [];

    /**
     * The CSS class associated with the animated clock
     */
    clockClass = 'stopped';

    /**
     * The different time units that a user can choose from and which one is currently selected
     */
    timeUnits = {
        second: true,
        minute: false,
        hour: false
    };

    /**
     * If this GM is considered the primary GM, if so all requests from players are filtered through this account.
     * @type {boolean}
     */
    public primary: boolean = false;
    /**
     * Timeout number associated with the check to see if this is the primary GM or not
     * @type {number | undefined}
     */
    private primaryCheckTimeout: number | undefined;
    /**
     * If the dialog has been resized
     * @type {boolean}
     */
    hasBeenResized: boolean = false;
    /**
     * The new note dialog
     * @type {SimpleCalendarNotes | undefined}
     */
    newNote: SimpleCalendarNotes | undefined;

    /**
     * Simple Calendar constructor
     */
    constructor() {super();}

    /**
     * Returns the default options for this application
     */
    static get defaultOptions() {
        Logger.debug('Simple Calendar -> defaultOptions()');
        const options = super.defaultOptions;
        options.template = "modules/foundryvtt-simple-calendar/templates/calendar.html";
        options.title = "FSC.Title";
        options.classes = ["simple-calendar"];
        options.resizable = true;
        return options;
    }

    /**
     * Initializes the dialogs once foundry is ready to go
     */
    public async init(){
        HandlebarsHelpers.Register();
        GameSettings.RegisterSettings();
        this.settingUpdate();
        await this.timeKeepingCheck();

        //Set up the socket we use to forward data between players and the GM
        game.socket.on(ModuleSocketName, this.processSocket.bind(this));
        if(this.currentYear){
            this.currentYear.time.updateUsers();
        }

        if(GameSettings.IsGm()){
            const socket = <SimpleCalendarSocket.Data>{
                type: SocketTypes.primary,
                data: <SimpleCalendarSocket.SimpleCalendarPrimary> {
                    primaryCheck: true
                }
            };
            this.primaryCheckTimeout = window.setTimeout(this.primaryCheckTimeoutCall.bind(this), 5000);
            game.socket.emit(ModuleSocketName, socket);
        }
    }

    /**
     * Called after the timeout delay set to see if another GM account has been set as the primary
     */
    primaryCheckTimeoutCall(){
        Logger.debug('No primary GM found, taking over as primary');
        this.primary = true;
        const socketData = <SimpleCalendarSocket.Data>{type: SocketTypes.primary, data: {amPrimary: this.primary}};
        game.socket.emit(ModuleSocketName, socketData);
    }

    /**
     * Process any data received over our socket
     * @param {SimpleCalendarSocket.Data} data The data received
     */
    async processSocket(data: SimpleCalendarSocket.Data){
        Logger.debug(`Processing ${data.type} socket emit`);
        if(data.type === SocketTypes.time){
            // This is processed by all players to update the animated clock
            this.clockClass = (<SimpleCalendarSocket.SimpleCalendarSocketTime>data.data).clockClass;
            this.updateApp();
        } else if (data.type === SocketTypes.journal){
            // If user is a GM and the primary GM then save the journal requests, otherwise do nothing
            if(GameSettings.IsGm() && this.primary){
                Logger.debug(`Saving notes from user.`);
                await GameSettings.SaveNotes((<SimpleCalendarSocket.SimpleCalendarSocketJournal>data.data).notes)
            }
        } else if (data.type === SocketTypes.primary){
            if(GameSettings.IsGm()){
                // Another client is asking if anyone is the primary GM, respond accordingly
                if((<SimpleCalendarSocket.SimpleCalendarPrimary>data.data).primaryCheck){
                    Logger.debug(`Checking if I am the primary`);
                    game.socket.emit(ModuleSocketName, <SimpleCalendarSocket.Data>{
                        type: SocketTypes.primary,
                        data: <SimpleCalendarSocket.SimpleCalendarPrimary> {
                            amPrimary: this.primary
                        }
                    });
                }
                // Another client has emitted that they are the primary, stop my check and set myself to not being the primary
                // This CAN lead to no primary if 2 GMs finish their primary check at the same time. This is best resolved by 1 gm reloading the page.
                else if((<SimpleCalendarSocket.SimpleCalendarPrimary>data.data).amPrimary !== undefined){
                    if((<SimpleCalendarSocket.SimpleCalendarPrimary>data.data).amPrimary){
                        Logger.debug('A primary GM is all ready present.');
                        window.clearTimeout(this.primaryCheckTimeout);
                        this.primary = false;
                    } else {
                        Logger.debug('We are all ready waiting to take over as primary.');
                    }
                }
            }
        }
    }

    /**
     * Gets the data object to be used by Handlebars when rending the HTML template
     */
    getData(options?: Application.RenderOptions): CalendarTemplate | Promise<CalendarTemplate> {
        if(this.currentYear){
            return {
                isGM: GameSettings.IsGm(),
                isPrimary: this.primary,
                addNotes: GameSettings.IsGm() || this.currentYear.generalSettings.playersAddNotes,
                currentYear: this.currentYear.toTemplate(),
                showSelectedDay: this.currentYear.visibleYear === this.currentYear.selectedYear,
                showCurrentDay: this.currentYear.visibleYear === this.currentYear.numericRepresentation,
                notes: this.getNotesForDay(),
                clockClass: this.clockClass,
                timeUnits: this.timeUnits
            };
        } else {
            return {
                isGM: false,
                isPrimary: this.primary,
                addNotes: false,
                currentYear: new Year(0).toTemplate(),
                showCurrentDay: false,
                showSelectedDay: false,
                notes: [],
                clockClass: this.clockClass,
                timeUnits: this.timeUnits
            };
        }
    }
    
    /**
     * Adds the calendar button to the token button list
     * @param controls
     */
    public getSceneControlButtons(controls: any[]){
        let tokenControls = controls.find(c => c.name === "token" );
        if(tokenControls && tokenControls.hasOwnProperty('tools')){
            tokenControls.tools.push({
                name: "calendar",
                title: "FSC.ButtonTitle",
                icon: "fas fa-calendar",
                button: true,
                onClick: SimpleCalendar.instance.showApp.bind(SimpleCalendar.instance)
            });
        }
    }

    /**
     * Shows the application window
     */
    public showApp(){
        this.hasBeenResized = false;
        this.render(true, {});
    }

    /**
     * Closes the application window
     */
    public closeApp(){
        this.close().catch(error => Logger.error(error));
    }

    /**
     * When the window is resized
     * @param event
     * @protected
     */
    protected _onResize(event: Event) {
        super._onResize(event);
        this.hasBeenResized = true;
    }

    /**
     * Sets the width and height of the calendar window so that it is sized to show the calendar, the controls and space for 2 notes.
     * @param {JQuery} html
     */
    setWidthHeight(html: JQuery){
        if(this.hasBeenResized){
            return;
        }
        const calendar = (<JQuery>html).find('.calendar-row .calendar-display');
        const controls = (<JQuery>html).find('.calendar-row .controls');
        const noteHeader = (<JQuery>html).find('.date-notes-header h2');
        const addNote = (<JQuery>html).find('.date-notes-header .add-note');

        let height = 0;
        let width = 0;

        if(calendar){
            const h = calendar.outerHeight(true);
            const w = calendar.outerWidth(true);
            height += h? h : 0;
            width += w? w : 0;
        }

        if(controls){
            const h = controls.outerHeight(true);
            const w = controls.outerWidth(true);
            if(h && h > height){
                height = h;
            }
            width += w? w : 0;
        }

        if(noteHeader && addNote){
            const nh = noteHeader.outerHeight(true);
            const nw = noteHeader.outerWidth(true);
            const w = addNote.outerWidth(true);

            const headerW = (nw? nw : 0) + (w?  w: 0);
            if(headerW > width){
                width = headerW;
            }
            height += (nh? nh : 0) + 24;
        }

        width += 16;
        height += (30 * 2) + 46;
        this.setPosition({width: width, height: height});
    }

    /**
     * Keeps the current/selected date centered in the list of days for a month on calendars that have very long day lists
     * @param {JQuery} html
     */
    ensureCurrentDateIsVisible(html: JQuery){
        const calendar = (<JQuery>html).find(".calendar");
        const calendarHeight = calendar.outerHeight();

        //This only needs to be processed if the calendar is more than 499px tall
        if(calendarHeight && calendarHeight >= 500){
            const currentDay = calendar.find('.day.current');
            const selectedDay = calendar.find('.day.selected');

            //Prefer to use the selected day as the main day to focus on rather than the current day
            let elementToUse = null;
            if(selectedDay.length){
                elementToUse = selectedDay[0];
            } else if(currentDay.length){
                elementToUse = currentDay[0];
            }

            if(elementToUse !== null){
                const calendarRect = calendar[0].getBoundingClientRect();
                const rect = elementToUse.getBoundingClientRect();
                const insideViewPort = rect.top >= calendarRect.top && rect.left >= calendarRect.left && rect.bottom <= calendarRect.bottom && rect.right <= calendarRect.right;
                if(!insideViewPort){
                    Logger.debug(`The Current/Selected day is not in the viewport, updating the day list scroll top position.`);
                    calendar[0].scrollTop = rect.top - calendarRect.top - (calendarHeight/ 2);
                }
            }
        }
    }

    /**
     * Adds any event listeners to the application DOM
     * @param {JQuery<HTMLElement>} html The root HTML of the application window
     * @protected
     */
    public activateListeners(html: JQuery<HTMLElement>) {
        Logger.debug('Simple-Calendar activateListeners()');
        if(html.hasOwnProperty("length")) {
            this.setWidthHeight(html);
            this.ensureCurrentDateIsVisible(html);
            // Change the month that is being viewed
            const nextPrev = (<JQuery>html).find(".current-date .fa");
            for (let i = 0; i < nextPrev.length; i++) {
                if (nextPrev[i].classList.contains('fa-chevron-left')) {
                    nextPrev[i].addEventListener('click', SimpleCalendar.instance.viewPreviousMonth.bind(this));
                } else if (nextPrev[i].classList.contains('fa-chevron-right')) {
                    nextPrev[i].addEventListener('click', SimpleCalendar.instance.viewNextMonth.bind(this));
                }
            }
            // Listener for when a day is clicked
            (<JQuery>html).find(".calendar .days .day").on('click', SimpleCalendar.instance.dayClick.bind(this));

            // Today button click
            (<JQuery>html).find(".calendar-controls .today").on('click', SimpleCalendar.instance.todayClick.bind(this));

            // When the GM Date controls are clicked
            (<JQuery>html).find(".time-controls .time-unit .selector").on('click', SimpleCalendar.instance.timeUnitClick.bind(this));
            (<JQuery>html).find(".controls .control").on('click', SimpleCalendar.instance.gmControlClick.bind(this));
            (<JQuery>html).find(".controls .btn-apply").on('click', SimpleCalendar.instance.dateControlApply.bind(this));

            //Configuration Button Click
            (<JQuery>html).find(".calendar-controls .configure-button").on('click', SimpleCalendar.instance.configurationClick.bind(this));

            // Add new note click
            (<JQuery>html).find(".date-notes .add-note").on('click', SimpleCalendar.instance.addNote.bind(this));

            // Note Click
            (<JQuery>html).find(".date-notes .note").on('click', SimpleCalendar.instance.viewNote.bind(this));

            (<JQuery>html).find(".time-start").on('click', SimpleCalendar.instance.startTime.bind(this));
            (<JQuery>html).find(".time-stop").on('click', SimpleCalendar.instance.stopTime.bind(this));
        }
    }

    /**
     * Click Event to change the month the user is currently viewing to the previous
     * @param {Event} e The click event
     */
    public viewPreviousMonth(e: Event){
        Logger.debug('Changing view to previous month');
        e.stopPropagation()
        if(this.currentYear){
            this.currentYear.changeMonth(-1);
            this.updateApp();
        }
    }

    /**
     * Click Event to change the month the user is currently viewing to the next
     * @param {Event} e The click event
     */
    public viewNextMonth(e: Event){
        Logger.debug('Changing view to next month');
        e.stopPropagation()
        if(this.currentYear){
            this.currentYear.changeMonth(1);
            this.updateApp();
        }
    }

    /**
     * Click event when a users clicks on a day
     * @param {Event} e The click event
     */
    public dayClick(e: Event){
        Logger.debug('Day Clicked');
        e.stopPropagation();
        const target = <HTMLElement>e.target;
        const dataDate = target.getAttribute('data-day');
        if(dataDate){
            const dayNumber = parseInt(dataDate);
            const isSelected = target.classList.contains('selected');
            if(this.currentYear && dayNumber > -1){
                this.currentYear.resetMonths('selected');
                if(!isSelected){
                    const visibleMonth = this.currentYear.getMonth('visible');
                    if(visibleMonth){
                        const dayIndex = visibleMonth.days.findIndex(d => d.numericRepresentation === dayNumber);
                        if(dayIndex > -1){
                            visibleMonth.selected = true;
                            visibleMonth.days[dayIndex].selected = true;
                            this.currentYear.selectedYear = this.currentYear.visibleYear;
                        }
                    }
                }
                this.updateApp();
            } else {
                Logger.error('Day has invalid data attribute or no current year is set!');
            }
        } else {
            Logger.error('Day is missing data attribute!');
        }
    }

    /**
     * Click event when a user clicks on the Today button
     * @param {Event} e The click event
     */
    public todayClick(e: Event) {
        e.preventDefault();
        if(this.currentYear){
            const selectedMonth = this.currentYear.getMonth('selected');
            if(selectedMonth){
                selectedMonth.selected = false;
                const selectedDay = selectedMonth.getDay('selected');
                if(selectedDay){
                    selectedDay.selected = false;
                }
            }
            const visibleMonth = this.currentYear.getMonth('visible');
            if(visibleMonth){
                visibleMonth.visible = false;
            }
            const currentMonth = this.currentYear.getMonth();
            if(currentMonth){
                const currentDay = currentMonth.getDay();
                if(currentDay){
                    this.currentYear.selectedYear = this.currentYear.numericRepresentation;
                    this.currentYear.visibleYear = this.currentYear.numericRepresentation;
                    currentMonth.visible = true;
                    currentMonth.selected = true;
                    currentDay.selected = true;
                    this.updateApp();
                }
            }
        }
    }

    /**
     * Click event when a user is changing the time unit to adjust
     * @param {Event} e The click event
     */
    public timeUnitClick(e: Event){
        e.stopPropagation();
        if(this.currentYear){
            const target = <HTMLElement>e.currentTarget;
            const dataType = target.getAttribute('data-type')?.toLowerCase() as 'second' | 'minute' | 'hour';
            this.timeUnits.second = false;
            this.timeUnits.minute = false;
            this.timeUnits.hour = false;
            this.timeUnits[dataType] = true;
            this.updateApp();
        }
    }

    /**
     * Click event when a gm user clicks on any of the next/back buttons for day/month/year
     * @param {Event} e The click event
     */
    public gmControlClick(e: Event){
        e.stopPropagation();
        if(this.currentYear){
            const target = <HTMLElement>e.currentTarget;
            const dataType = target.getAttribute('data-type');
            const isNext = target.classList.contains('next');
            switch (dataType){
                case 'time':
                    const dataAmount = target.getAttribute('data-amount');
                    if(dataAmount){
                        const amount = parseInt(dataAmount);
                        if(!isNaN(amount)){
                            Logger.debug(`${isNext? 'Forward' : 'Back'} Time Clicked`);
                            const unit = this.timeUnits.second? 'second' : this.timeUnits.minute? 'minute' : 'hour';
                            this.currentYear.changeTime(isNext, unit, amount);
                            this.updateApp();
                        }
                    }
                    break;
                case 'day':
                    Logger.debug(`${isNext? 'Forward' : 'Back'} Day Clicked`);
                    this.currentYear.changeDay(isNext? 1 : -1, 'current');
                    this.updateApp();
                    break;
                case 'month':
                    Logger.debug(`${isNext? 'Forward' : 'Back'} Month Clicked`);
                    this.currentYear.changeMonth(isNext? 1 : -1, 'current');
                    this.updateApp();
                    break;
                case 'year':
                    Logger.debug(`${isNext? 'Forward' : 'Back'} Year Clicked`);
                    this.currentYear.changeYear(isNext? 1 : -1, false, "current");
                    this.updateApp();
                    break;
            }
        }
    }

    /**
     * Click event for when a gm user clicks on the apply button for the current date controls
     * Will attempt to save the new current date to the world settings.
     * @param {Event} e The click event
     */
    public dateControlApply(e: Event){
        e.stopPropagation();
        if(GameSettings.IsGm()){
            if(this.currentYear) {
                GameSettings.SaveCurrentDate(this.currentYear).catch(Logger.error);
                //Sync the current time on apply, this will propagate to other modules
                this.currentYear.syncTime().catch(Logger.error);
            }
        } else {
            GameSettings.UiNotification(GameSettings.Localize("FSC.Error.Calendar.GMCurrent"), 'warn');
        }
    }

    /**
     * Click event for when a gm user clicks on the configuration button to configure the game calendar
     * @param {Event} e The click event
     */
    public configurationClick(e: Event) {
        e.stopPropagation();
        if(GameSettings.IsGm()){
            if(this.currentYear){
                if(!SimpleCalendarConfiguration.instance || (SimpleCalendarConfiguration.instance && !SimpleCalendarConfiguration.instance.rendered)){
                    SimpleCalendarConfiguration.instance = new SimpleCalendarConfiguration(this.currentYear.clone());
                    SimpleCalendarConfiguration.instance.showApp();
                } else {
                    SimpleCalendarConfiguration.instance.bringToTop();
                }
            } else {
                Logger.error('The Current year is not configured.');
            }
        } else {
            GameSettings.UiNotification(GameSettings.Localize("FSC.Error.Calendar.GMConfigure"), 'warn');
        }
    }

    /**
     * Opens up the note adding dialog
     * @param {Event} e The click event
     */
    public addNote(e: Event) {
        e.stopPropagation();
        if(this.currentYear){
            if(game.users && !game.users.find(u => u.isGM && u.active)){
                GameSettings.UiNotification(game.i18n.localize('FSC.Warn.Notes.NotGM'), 'warn');
            } else {
                const currentMonth = this.currentYear.getMonth('selected') || this.currentYear.getMonth();
                if(currentMonth){
                    const currentDay = currentMonth.getDay('selected') || currentMonth.getDay();
                    if(currentDay){
                        const year = this.currentYear.selectedYear || this.currentYear.numericRepresentation;
                        const month = currentMonth.numericRepresentation;
                        const day = currentDay.numericRepresentation;
                        const newNote = new Note();
                        newNote.year = year;
                        newNote.month = month;
                        newNote.day = day;
                        newNote.monthDisplay = currentMonth.name;
                        newNote.title = '';
                        newNote.author = GameSettings.UserID();
                        newNote.playerVisible = GameSettings.GetDefaultNoteVisibility();
                        if(this.newNote !== undefined){
                            this.newNote.closeApp();
                            this.newNote = undefined;
                        }
                        this.newNote = new SimpleCalendarNotes(newNote);
                        this.newNote.showApp();
                    } else {
                        GameSettings.UiNotification(GameSettings.Localize("FSC.Error.Note.NoSelectedDay"), 'warn');
                    }
                } else {
                    GameSettings.UiNotification(GameSettings.Localize("FSC.Error.Note.NoSelectedMonth"), 'warn');
                }
            }
        } else {
            Logger.error('The Current year is not configured.');
        }
    }

    /**
     * Opens up a note to view the contents
     * @param {Event} e The click event
     */
    public viewNote(e: Event){
        e.stopPropagation();
        const dataIndex = (<HTMLElement>e.currentTarget).getAttribute('data-index');
        if(dataIndex){
            const note = this.notes.find(n=> n.id === dataIndex);
            if(note){
                SimpleCalendarNotes.instance = new SimpleCalendarNotes(note, true);
                SimpleCalendarNotes.instance.showApp();
            }
        } else {
            Logger.error('No Data index on note element found.');
        }
    }

    /**
     * Re renders the application window
     * @private
     */
    public updateApp(){
        if(this.rendered){
            this.render(false);
        }
    }

    /**
     * Called when a setting is updated, refreshes the configurations for all types
     * @param {boolean} [update=false] If to update the display
     * @param {string} [type='all']
     */
    public settingUpdate(update: boolean = false, type: string = 'all'){
        if(type === 'all' || type === 'year'){
            this.loadYearConfiguration();
        }
        if(type === 'all' || type === 'month'){
            this.loadMonthConfiguration();
        }
        if(type === 'all' || type === 'weekday'){
            this.loadWeekdayConfiguration();
        }
        if(type === 'all' || type === 'notes'){
            this.loadNotes();
        }
        if(type === 'leapyear'){
            this.currentYear?.leapYearRule.loadFromSettings();
        }
        if(type === 'all' || type === 'time'){
            this.loadTimeConfiguration();
        }
        if(type === 'all' || type === 'season'){
            this.loadSeasonConfiguration();
        }
        if(type === 'all' || type === 'moon'){
            this.loadMoonConfiguration();
        }
        if(type === 'all' || type === 'general'){
            this.loadGeneralSettings();
        }
        this.loadCurrentDate();
        if(update) {
            this.updateApp();
        }
    }

    /**
     * Loads the general settings from the world settings and apply them
     * @private
     */
    private loadGeneralSettings(){
        Logger.debug('Loading general settings from world settings');
        const gSettings = GameSettings.LoadGeneralSettings();
        if(gSettings && Object.keys(gSettings).length){
            if(this.currentYear){
                this.currentYear.generalSettings = gSettings;
            } else {
                Logger.error('No Current year configured, can not load general settings.');
            }
        }
    }

    /**
     * Loads the year configuration data from the settings and applies them to the current year
     */
    private loadYearConfiguration(){
        Logger.debug('Loading year configuration from settings.');

        const yearData = GameSettings.LoadYearData();
        if(yearData && Object.keys(yearData).length){
            Logger.debug('Setting the year from data.');
            if(!this.currentYear){
                this.currentYear = new Year(yearData.numericRepresentation);
            } else {
                this.currentYear.numericRepresentation = yearData.numericRepresentation;
            }
            this.currentYear.prefix = yearData.prefix;
            this.currentYear.postfix = yearData.postfix;

            if(yearData.hasOwnProperty('showWeekdayHeadings')){
                this.currentYear.showWeekdayHeadings = yearData.showWeekdayHeadings;
            }
            if(yearData.hasOwnProperty('firstWeekday')){
                this.currentYear.firstWeekday = yearData.firstWeekday;
            }
        } else {
            Logger.debug('No year configuration found, setting default year data.');
            this.currentYear = new Year(new Date().getFullYear());
        }
    }

    /**
     * Loads the month configuration data from the settings and applies them to the current year
     */
    private loadMonthConfiguration(){
        Logger.debug('Loading month configuration from settings.');
        if(this.currentYear){
            const monthData = GameSettings.LoadMonthData();
            if(monthData.length){
                this.currentYear.months = [];
                Logger.debug('Setting the months from data.');
                for(let i = 0; i < monthData.length; i++){
                    if(Object.keys(monthData[i]).length){
                        let numDays = parseInt(monthData[i].numberOfDays.toString());
                        let numLeapDays = monthData[i].numberOfLeapYearDays === undefined? 0 : parseInt(monthData[i].numberOfLeapYearDays.toString());
                        if(isNaN(numDays)){
                            numDays = 1;
                        }
                        if(isNaN(numLeapDays)){
                            numLeapDays = 1;
                        }
                        const newMonth = new Month(monthData[i].name, monthData[i].numericRepresentation, monthData[i].numericRepresentationOffset, numDays, numLeapDays);
                        newMonth.intercalary = monthData[i].intercalary;
                        newMonth.intercalaryInclude = monthData[i].intercalaryInclude;
                        this.currentYear.months.push(newMonth);
                    }
                }
            }
            if(this.currentYear.months.length === 0) {
                Logger.debug('No month configuration found, setting default month data.');
                this.currentYear.months = [
                    new Month(GameSettings.Localize("FSC.Date.January"), 1, 0, 31),
                    new Month(GameSettings.Localize("FSC.Date.February"), 2, 0, 28, 29),
                    new Month(GameSettings.Localize("FSC.Date.March"),3, 0, 31),
                    new Month(GameSettings.Localize("FSC.Date.April"),4, 0, 30),
                    new Month(GameSettings.Localize("FSC.Date.May"),5, 0, 31),
                    new Month(GameSettings.Localize("FSC.Date.June"),6, 0, 30),
                    new Month(GameSettings.Localize("FSC.Date.July"),7, 0, 31),
                    new Month(GameSettings.Localize("FSC.Date.August"),8, 0, 31),
                    new Month(GameSettings.Localize("FSC.Date.September"),9, 0, 30),
                    new Month(GameSettings.Localize("FSC.Date.October"), 10, 0, 31),
                    new Month(GameSettings.Localize("FSC.Date.November"), 11, 0, 30),
                    new Month(GameSettings.Localize("FSC.Date.December"), 12, 0, 31),
                ];
            }
        } else {
            Logger.error('No Current year configured, can not load month data.');
        }
    }

    /**
     * Loads the weekday configuration data from the settings and applies them to the current year
     */
    private loadWeekdayConfiguration(){
        Logger.debug('Loading weekday configuration from settings.');
        if(this.currentYear){
            const weekdayData = GameSettings.LoadWeekdayData();
            if(weekdayData.length){
                Logger.debug('Setting the weekdays from data.');
                this.currentYear.weekdays = [];
                for(let i = 0; i < weekdayData.length; i++){
                    this.currentYear.weekdays.push(new Weekday(weekdayData[i].numericRepresentation, weekdayData[i].name));
                }
            } else {
                Logger.debug('No weekday configuration found, loading default data.');
                this.currentYear.weekdays = [
                    new Weekday(1, GameSettings.Localize('FSC.Date.Sunday')),
                    new Weekday(2, GameSettings.Localize('FSC.Date.Monday')),
                    new Weekday(3, GameSettings.Localize('FSC.Date.Tuesday')),
                    new Weekday(4, GameSettings.Localize('FSC.Date.Wednesday')),
                    new Weekday(5, GameSettings.Localize('FSC.Date.Thursday')),
                    new Weekday(6, GameSettings.Localize('FSC.Date.Friday')),
                    new Weekday(7, GameSettings.Localize('FSC.Date.Saturday'))
                ];
            }
        } else {
            Logger.error('No Current year configured, can not load weekday data.');
        }
    }

    /**
     * Loads the season configuration data from the settings and applies them to the current year
     * @private
     */
    private loadSeasonConfiguration(){
        Logger.debug('Loading season configuration from settings.');
        if(this.currentYear){
            const seasonData = GameSettings.LoadSeasonData();
            this.currentYear.seasons = [];
            if(seasonData.length){
                Logger.debug('Setting the seasons from data.');
                for(let i = 0; i < seasonData.length; i++){
                    const newSeason = new Season(seasonData[i].name, seasonData[i].startingMonth, seasonData[i].startingDay);
                    newSeason.color = seasonData[i].color;
                    newSeason.customColor = seasonData[i].customColor;
                    this.currentYear.seasons.push(newSeason);
                }
            }
        } else {
            Logger.error('No Current year configured, can not load season data.');
        }
    }

    /**
     * Loads the moon configuration data from the settings and applies them to the current year
     * @private
     */
    private loadMoonConfiguration(){
        Logger.debug('Loading moon configuration from settings.');
        if(this.currentYear){
            const moonData = GameSettings.LoadMoonData();
            this.currentYear.moons = [];
            if(moonData.length){
                Logger.debug('Setting the moons from data.');
                for(let i = 0; i < moonData.length; i++){
                    const newMoon = new Moon(moonData[i].name, moonData[i].cycleLength);
                    newMoon.phases = moonData[i].phases;
                    newMoon.firstNewMoon = {
                        yearReset: moonData[i].firstNewMoon.yearReset,
                        yearX: moonData[i].firstNewMoon.yearX,
                        year: moonData[i].firstNewMoon.year,
                        month: moonData[i].firstNewMoon.month,
                        day: moonData[i].firstNewMoon.day
                    };
                    newMoon.color = moonData[i].color;
                    newMoon.cycleDayAdjust = moonData[i].cycleDayAdjust;
                    this.currentYear.moons.push(newMoon);
                }
            }
        } else {
            Logger.error('No Current year configured, can not load moon data.');
        }
    }

    /**
     * Loads the time configuration from the settings and applies them to the current year
     * @private
     */
    private loadTimeConfiguration(){
        Logger.debug('Loading time configuration from settings.');
        if(this.currentYear){
            const timeData = GameSettings.LoadTimeData();
            if(timeData && Object.keys(timeData).length){
                this.currentYear.time.hoursInDay = timeData.hoursInDay;
                this.currentYear.time.minutesInHour = timeData.minutesInHour;
                this.currentYear.time.secondsInMinute = timeData.secondsInMinute;
                this.currentYear.time.gameTimeRatio = timeData.gameTimeRatio;
            }
        } else {
            Logger.error('No Current year configured, can not load time data.');
        }
    }

    /**
     * Loads the current date data from the settings and applies them to the current year
     */
    private loadCurrentDate(){
        Logger.debug('Loading current date from settings.');
        const currentDate = GameSettings.LoadCurrentDate();
        if(this.currentYear && currentDate && Object.keys(currentDate).length){
            this.currentYear.numericRepresentation = currentDate.year;
            this.currentYear.visibleYear = currentDate.year;
            this.currentYear.selectedYear = currentDate.year;

            this.currentYear.resetMonths('current');
            this.currentYear.resetMonths('visible');

            const month = this.currentYear.months.find(m => m.numericRepresentation === currentDate.month);
            if(month){
                month.current = true;
                month.visible = true;
                const day = month.days.find(d => d.numericRepresentation === currentDate.day);
                if(day){
                    day.current = true;
                } else {
                    Logger.error('Save day could not be found in this month, perhaps number of days has changed. Setting current day to first day of month');
                    month.days[0].current = true;
                }
            } else {
                Logger.error('Saved month could not be found, perhaps months have changed. Setting current month to the first month');
                this.currentYear.months[0].current = true;
                this.currentYear.months[0].visible = true;
                this.currentYear.months[0].days[0].current = true;
            }
            this.currentYear.time.seconds = currentDate.seconds;
            if(this.currentYear.time.seconds === undefined){
                this.currentYear.time.seconds = 0;
            }
        } else if(this.currentYear && this.currentYear.months.length) {
            Logger.debug('No current date setting found, setting default current date.');
            this.currentYear.months[0].current = true;
            this.currentYear.months[0].visible = true;
            this.currentYear.months[0].days[0].current = true;
        } else {
            Logger.error('Error setting the current date.');
        }
    }

    /**
     * Loads the notes from the game setting
     * @private
     */
    public loadNotes(update = false){
        Logger.debug('Loading notes from settings.');
        const notes = GameSettings.LoadNotes();
        this.notes = notes.map(n => {
            const note = new Note();
            note.loadFromConfig(n);
            return note;
        });
        if(update){
            this.updateApp();
        }
    }

    /**
     * Gets all of the notes associated with the selected or current day
     * @private
     * @return NoteTemplate[]
     */
    private getNotesForDay(): NoteTemplate[] {
        const dayNotes: NoteTemplate[] = [];
        if(this.currentYear){
            const year = this.currentYear.selectedYear || this.currentYear.numericRepresentation;
            const month = this.currentYear.getMonth('selected') || this.currentYear.getMonth();
            if(month){
                const day = month.getDay('selected') || month.getDay();
                if(day){
                    this.notes.forEach((note) => {
                        if(note.isVisible(year, month.numericRepresentation, day.numericRepresentation)){
                            dayNotes.push(note.toTemplate());
                        }
                    });
                }
            }
        }
        return dayNotes;
    }

    /**
     * Triggered when anything updates the game world time
     * @param {number} newTime The total time in seconds
     * @param {number} delta How much the newTime has changed from the old time in seconds
     */
    worldTimeUpdate(newTime: number, delta: number){
        Logger.debug(`World Time Update, new time: ${newTime}. Delta of: ${delta}.`);
        if(this.currentYear){
            this.currentYear.setFromTime(newTime, delta);
        }
    }

    /**
     * Triggered when a combat is create/started/turn advanced
     * @param {Combat} combat The specific combat data
     * @param {Combat.CurrentTurn} round The current turns data
     * @param {Object} time The amount of time that has advanced
     */
    combatUpdate(combat: Combat, round: Combat.CurrentTurn, time: any){
        Logger.debug('Combat Update');
        if(this.currentYear && combat.started){
            this.currentYear.time.combatRunning = true;
            this.currentYear.time.updateUsers();
            if(time && time.hasOwnProperty('advanceTime')){
                Logger.debug('Combat Change Triggered');
                this.currentYear.combatChangeTriggered = true;
            }
        }
    }

    /**
     * Triggered when a combat is finished and removed
     */
    combatDelete(){
        Logger.debug('Combat Ended');
        if(this.currentYear){
            this.currentYear.time.combatRunning = false;
            this.currentYear.time.updateUsers();
        }
    }

    /**
     * Triggered when the game is paused/un-paused
     * @param {boolean} paused If the game is now paused or not
     */
    gamePaused(paused: boolean){
        if(this.currentYear){
            this.currentYear.time.updateUsers();
        }
    }

    /**
     * Starts the built in time keeper
     */
    startTime(){
        if(this.currentYear){
            if(game.combats && game.combats.size > 0 && game.combats.find(g => g.started)){
                GameSettings.UiNotification(game.i18n.localize('FSC.Warn.Time.ActiveCombats'), 'warn');
            } else if(this.currentYear.generalSettings.gameWorldTimeIntegration === GameWorldTimeIntegrations.Self || this.currentYear.generalSettings.gameWorldTimeIntegration === GameWorldTimeIntegrations.Mixed){
                this.currentYear.time.startTimeKeeper();
            }
        }
    }

    /**
     * Stops the built in time keeper
     */
    stopTime(){
        if(this.currentYear){
            this.currentYear.time.stopTimeKeeper();
        }
    }

    /**
     * Checks to see if the module import/export dialog needs to be shown and syncs the game world time with the simple calendar
     */
    async timeKeepingCheck(){
        //If the current year is set up and the calendar is set up for time keeping and the user is the GM
        if(this.currentYear && this.currentYear.generalSettings.gameWorldTimeIntegration !== GameWorldTimeIntegrations.None && GameSettings.IsGm() ){
            const importRun = GameSettings.GetImportRan();
            // If we haven't asked about the import in the past
            if(!importRun){
                const calendarWeather = game.modules.get('calendar-weather');
                const aboutTime = game.modules.get('about-time');
                //Ask about calendar/weather first, then about time
                if(calendarWeather && calendarWeather.active){
                    Logger.debug('Calendar/Weather detected.');
                    const cwD = new Dialog({
                        title: GameSettings.Localize('FSC.Module.CalendarWeather.Title'),
                        content: GameSettings.Localize('FSC.Module.CalendarWeather.Message'),
                        buttons:{
                            import: {
                                label: GameSettings.Localize('FSC.Module.Import'),
                                callback: this.moduleImportClick.bind(this, 'calendar-weather')
                            },
                            export: {
                                label: GameSettings.Localize('FSC.Module.CalendarWeather.Export'),
                                callback: this.moduleExportClick.bind(this,'calendar-weather')
                            },
                            no: {
                                label: GameSettings.Localize('FSC.Module.NoChanges'),
                                callback: this.moduleDialogNoChangeClick.bind(this)
                            }
                        },
                        default: "no"
                    });
                    cwD.render(true);
                } else if(aboutTime && aboutTime.active){
                    Logger.debug(`About Time detected.`);
                    const cwD = new Dialog({
                        title: GameSettings.Localize('FSC.Module.AboutTime.Title'),
                        content: GameSettings.Localize('FSC.Module.AboutTime.Message'),
                        buttons:{
                            import: {
                                label: GameSettings.Localize('FSC.Module.Import'),
                                callback: this.moduleImportClick.bind(this, 'about-time')
                            },
                            export: {
                                label: GameSettings.Localize('FSC.Module.AboutTime.Export'),
                                callback: this.moduleExportClick.bind(this,'about-time')
                            },
                            no: {
                                label: GameSettings.Localize('FSC.Module.NoChanges'),
                                callback: this.moduleDialogNoChangeClick.bind(this)
                            }
                        },
                        default: "no"
                    });
                    cwD.render(true);
                }
            }

            //Sync the current world time with the simple calendar
            await this.currentYear.syncTime();
        }
    }

    /**
     * Called when the import option is selection from the importing/exporting module dialog
     * @param {string} type The module
     */
    async moduleImportClick(type: string) {
        if(this.currentYear){
            if(type === 'about-time'){
                await Importer.importAboutTime(this.currentYear);
                this.updateApp();
            } else if(type === 'calendar-weather'){
                await Importer.importCalendarWeather(this.currentYear);
                this.updateApp();
            }
            await GameSettings.SetImportRan(true);
        } else {
            Logger.error('Could not export as the current year is not defined');
        }
    }

    /**
     * Called when the export option is selection from the importing/exporting module dialog
     * @param {string} type The module
     */
    async moduleExportClick(type: string){
        if(this.currentYear){
            if(type === 'about-time'){
                await Importer.exportToAboutTime(this.currentYear);
            } else if(type === 'calendar-weather'){
                await Importer.exportCalendarWeather(this.currentYear);
            }
            await GameSettings.SetImportRan(true);
        } else {
            Logger.error('Could not export as the current year is not defined');
        }
    }

    /**
     * Called when the no change dialog option is clicked for importing/exporting module data
     */
    async moduleDialogNoChangeClick(){
        await GameSettings.SetImportRan(true);
    }

}
