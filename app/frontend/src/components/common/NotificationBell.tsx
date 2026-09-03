import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../../contexts/RoleContext'
import {
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  getUnreadCount,
  formatNotificationTime,
  getNotificationIcon,
  type Notification
} from '../../services/notifications'

export function NotificationBell() {
  const { t } = useTranslation()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { role } = useRole()

  // Fetch notifications on mount and periodically
  useEffect(() => {
    loadNotifications()
    
    // Poll every 30 seconds
    const interval = setInterval(loadNotifications, 30000)
    return () => clearInterval(interval)
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const loadNotifications = async () => {
    try {
      const data = await fetchNotifications()
      setNotifications(data)
    } catch (error) {
      console.warn('Failed to load notifications:', error)
    }
  }

  const handleMarkRead = async (id: string) => {
    await markNotificationRead(id)
    setNotifications(prev => 
      prev.map(n => n.id === id ? { ...n, read: true } : n)
    )
  }

  const handleMarkAllRead = async () => {
    setIsLoading(true)
    await markAllNotificationsRead()
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
    setIsLoading(false)
  }

  const handleDismiss = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await dismissNotification(id)
    setNotifications(prev => prev.filter(n => n.id !== id))
  }

  const handleNotificationClick = (notification: Notification) => {
    handleMarkRead(notification.id)
    
    // Navigate based on notification type and action
    if (notification.type === 'ami-update' || notification.type === 'verification-required') {
      if (role === 'biologist') {
        // Navigate to attestation tab to verify backend
        navigate('/attestation')
      }
    }
    
    setIsOpen(false)
  }

  const unreadCount = getUnreadCount(notifications)

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
        aria-label={unreadCount > 0
          ? t('common.notification-bell.ariaLabelUnread', { count: unreadCount })
          : t('common.notification-bell.ariaLabel')}
      >
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        
        {/* Unread Badge */}
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-96 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-900 border-b">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">{t('common.notification-bell.title')}</h3>
            {notifications.length > 0 && (
              <button
                onClick={handleMarkAllRead}
                disabled={isLoading || unreadCount === 0}
                className="text-sm text-primary-600 hover:text-primary-700 disabled:text-gray-400"
              >
                {t('common.notification-bell.markAllRead')}
              </button>
            )}
          </div>

          {/* Notification List */}
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                <span className="text-3xl block mb-2">🔔</span>
                <p>{t('common.notification-bell.noNotifications')}</p>
              </div>
            ) : (
              notifications.slice(0, 10).map(notification => (
                <div
                  key={notification.id}
                  onClick={() => handleNotificationClick(notification)}
                  className={`
                    px-4 py-3 border-b border-gray-100 dark:border-gray-700 cursor-pointer transition-colors
                    ${notification.read ? 'bg-white dark:bg-gray-800' : 'bg-blue-50 dark:bg-blue-900'}
                    hover:bg-gray-50 dark:hover:bg-gray-700
                  `}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-xl">
                      {getNotificationIcon(notification.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className={`text-sm font-medium ${notification.read ? 'text-gray-700 dark:text-gray-300' : 'text-gray-900 dark:text-gray-100'}`}>
                          {notification.title}
                        </p>
                        <button
                          onClick={(e) => handleDismiss(notification.id, e)}
                          className="text-gray-400 hover:text-gray-600 ml-2"
                        >
                          ✕
                        </button>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5 line-clamp-2">
                        {notification.message}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-gray-400">
                          {formatNotificationTime(notification.timestamp)}
                        </span>
                        {notification.action_required && !notification.read && (
                          <span className="text-xs bg-yellow-100 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200 px-1.5 py-0.5 rounded">
                            {t('common.notification-bell.actionRequired')}
                          </span>
                        )}
                      </div>
                      
                      {/* PCR Values Preview for AMI updates */}
                      {notification.type === 'ami-update' && notification.pcr_values && (
                        <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-700 rounded text-xs">
                          <span className="font-medium">{t('common.notification-bell.newPcrValues')}</span>
                          {notification.pcr_values.pcr4 && (
                            <div className="truncate text-gray-600 dark:text-gray-400">
                              {t('common.notification-bell.pcr4Preview', { value: notification.pcr_values.pcr4.substring(0, 32) })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          {notifications.length > 10 && (
            <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-t text-center">
              <button className="text-sm text-primary-600 hover:text-primary-700">
                {t('common.notification-bell.viewAll')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}