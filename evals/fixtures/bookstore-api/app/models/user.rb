class User < ApplicationRecord
  has_many :orders, dependent: :nullify
  has_secure_password

  validates :email, presence: true, uniqueness: true, format: { with: URI::MailTo::EMAIL_REGEXP }
  validates :name, presence: true

  before_save :downcase_email

  def self.authenticate(email, password)
    user = find_by(email: email.downcase)
    return nil unless user&.authenticate(password)

    user
  end

  def total_spent
    orders.where(status: Order::STATUS_CONFIRMED).sum(:total_cents)
  end

  def admin?
    role == 'admin'
  end

  private

  def downcase_email
    self.email = email.downcase if email.present?
  end
end
