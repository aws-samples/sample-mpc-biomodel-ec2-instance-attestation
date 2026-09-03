/**
 * Notification Service
 * 
 * Handles fetching notifications from SSM Parameter Store
 * and managing notification state
 */

import { getParameter, putParameter } from './ssm'

export interface Notification {
  id: string
  type: 'ami-update' | 'deployment' | 'verification-required' | 'info'
  timestamp: string
  source: string
  title: string
  message: string
  ami_id?: string
  pcr_values?: {
    pcr4?: string
    pcr7?: string
    pcr12?: string
    pcr16?: string
  }
  action_required: boolean
  read: boolean
}

interface NotificationData {
  notifications: Notification[]
}

const NOTIFICATION_PARAM = '/boltz/notifications/prod'

/**
 * Fetch notifications from SSM Parameter Store
 */
export async function fetchNotifications(): Promise<Notification[]> {
  try {
    const value = await getParameter(NOTIFICATION_PARAM)
    if (!value) {
      return []
    }
    const data: NotificationData = JSON.parse(value)
    return data.notifications || []
  } catch (error) {
    console.warn('Failed to fetch notifications:', error)
    return []
  }
}

/**
 * Mark a notification as read
 */
export async function markNotificationRead(notificationId: string): Promise<void> {
  try {
    const notifications = await fetchNotifications()
    const updated = notifications.map(n => 
      n.id === notificationId ? { ...n, read: true } : n
    )
    await putParameter(NOTIFICATION_PARAM, JSON.stringify({ notifications: updated }))
  } catch (error) {
    console.error('Failed to mark notification as read:', error)
  }
}

/**
 * Mark all notifications as read
 */
export async function markAllNotificationsRead(): Promise<void> {
  try {
    const notifications = await fetchNotifications()
    const updated = notifications.map(n => ({ ...n, read: true }))
    await putParameter(NOTIFICATION_PARAM, JSON.stringify({ notifications: updated }))
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error)
  }
}

/**
 * Dismiss a notification (remove it)
 */
export async function dismissNotification(notificationId: string): Promise<void> {
  try {
    const notifications = await fetchNotifications()
    const updated = notifications.filter(n => n.id !== notificationId)
    await putParameter(NOTIFICATION_PARAM, JSON.stringify({ notifications: updated }))
  } catch (error) {
    console.error('Failed to dismiss notification:', error)
  }
}

/**
 * Get unread notification count
 */
export function getUnreadCount(notifications: Notification[]): number {
  return notifications.filter(n => !n.read).length
}

/**
 * Get action-required notification count
 */
export function getActionRequiredCount(notifications: Notification[]): number {
  return notifications.filter(n => n.action_required && !n.read).length
}

/**
 * Format notification time relative to now
 */
export function formatNotificationTime(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

/**
 * Get notification icon based on type
 */
export function getNotificationIcon(type: Notification['type']): string {
  switch (type) {
    case 'ami-update':
      return '🆕'
    case 'deployment':
      return '🚀'
    case 'verification-required':
      return '⚠️'
    case 'info':
    default:
      return 'ℹ️'
  }
}