# Calendar Views

TaskNotes provides two calendar-based views for visualizing and managing your tasks: the **Mini Calendar** and the **Advanced Calendar**.

## Mini Calendar View

The Mini Calendar is a month-based view that shows which days have tasks. It is designed for navigation and for providing an overview of your task distribution.

## Advanced Calendar View

The Advanced Calendar is a calendar with multiple view modes (month, week, day, year, and custom days), drag-and-drop scheduling, and time-blocking capabilities. You can create new tasks by clicking on dates or time slots, and you can reschedule tasks by dragging them to a new date or time.

### Custom Days View

The Custom Days view provides a configurable multi-day calendar that displays between 2-10 days at once. This view addresses screen space utilization by offering a middle ground between the single-day view and the full week view.

#### Key Features

- **Configurable Duration**: Set the number of days to display (2-10 days) via Settings > Calendar > Custom view day count
- **TimeGrid Format**: Uses the same hourly time slots and time-based event layout as Week and Day views
- **Real-time Updates**: The view updates immediately when the day count setting is changed
- **Default Configuration**: Ships with 3 days displayed by default for optimal space utilization

#### Use Cases

The Custom Days view is particularly useful for:
- Users who find the single-day view too wide and wasteful of screen space
- Planning workflows that require seeing a few days at a glance without the full week
- Detailed scheduling tasks that benefit from the time-grid format
- Customizing the viewing window to match personal preference and screen size

#### Configuration

1. **Select the View**: Choose "Custom Days" from the calendar toolbar alongside Month, Week, Day, and Year views
2. **Adjust Day Count**: Navigate to Settings > Calendar > Custom view day count and use the slider to select 2-10 days
3. **Set as Default**: Optionally set "Custom Days" as your default view in Settings > Calendar > Default view

### Recurring Task Support

The Advanced Calendar handles recurring tasks with proper all-day event support and allows duration updates through calendar resize operations. When dragging or resizing recurring task events, the changes apply to that specific occurrence while preserving the recurrence pattern.

### View Options

The Advanced Calendar provides several display options that control what types of events appear on the calendar:

- **Show scheduled**: Display tasks with scheduled dates
- **Show due**: Display tasks with due dates
- **Show timeblocks**: Display time-blocking entries
- **Show recurring**: Display recurring task events
- **Show ICS events**: Display events from imported ICS calendars
- **Show time entries**: Display time tracking entries

These display options are preserved when you save a view, allowing you to create specialized calendar views that show only specific types of events and maintain those preferences across sessions.

### FilterBar Integration

The Advanced Calendar View includes the same FilterBar functionality as the Task List View, allowing you to filter which tasks appear on the calendar and save views. See the [Task List View](task-list.md) documentation for complete FilterBar functionality details.